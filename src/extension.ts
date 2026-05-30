import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';

type Kind = 'resource' | 'data' | 'module' | 'variable' | 'output' | 'local';

interface Detection {
  kind: Kind;
  // For resource and data, oldName is "TYPE.NAME". For others, just "NAME".
  oldName: string;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_-]*';
const reIdent = new RegExp(`^${IDENT}$`);
const reDeclResource = new RegExp(`^\\s*resource\\s+"(${IDENT})"\\s+"(${IDENT})"`);
const reDeclData = new RegExp(`^\\s*data\\s+"(${IDENT})"\\s+"(${IDENT})"`);
const reDeclModule = new RegExp(`^\\s*module\\s+"(${IDENT})"`);
const reDeclVariable = new RegExp(`^\\s*variable\\s+"(${IDENT})"`);
const reDeclOutput = new RegExp(`^\\s*output\\s+"(${IDENT})"`);
const reLocalAttr = new RegExp(`^\\s*(${IDENT})\\s*=`);

const KIND_LABEL: Record<Kind, string> = {
  resource: 'resource',
  data: 'data source',
  module: 'module',
  variable: 'variable',
  output: 'output',
  local: 'local',
};

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tfrename.rename', runRename),
  );
}

export function deactivate(): void {
  // nothing to clean up
}

async function runRename(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('tfrename: no active editor');
    return;
  }
  const doc = editor.document;
  if (path.extname(doc.fileName) !== '.tf') {
    vscode.window.showErrorMessage('tfrename: active file is not a .tf file');
    return;
  }

  const detection = detect(doc, editor.selection);
  if (!detection) {
    vscode.window.showErrorMessage(
      'tfrename: could not identify a Terraform symbol at the cursor or selection',
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration('tfrename');
  const defaultMoved = cfg.get<boolean>('moved', false);
  const result = await promptNewName(detection, defaultMoved);
  if (result === undefined) {
    return;
  }
  if (result.newName === detection.oldName) {
    vscode.window.showInformationMessage('tfrename: new name is the same as the old name');
    return;
  }

  const label = KIND_LABEL[detection.kind];
  const dir = path.dirname(doc.fileName);
  // tfrename rewrites every *.tf in the directory, so any other open .tf
  // document in the same directory must be flushed first. Otherwise VS Code
  // detects the on-disk change and prompts to reload, putting the user at
  // risk of losing unsaved edits or applying the rename to stale buffers.
  const dirtyTfDocs = vscode.workspace.textDocuments.filter(
    (d) =>
      d.isDirty &&
      path.extname(d.fileName) === '.tf' &&
      path.dirname(d.fileName) === dir,
  );
  for (const d of dirtyTfDocs) {
    if (!(await d.save())) {
      vscode.window.showErrorMessage(
        `tfrename: could not save ${path.basename(d.fileName)}; aborting to avoid renaming stale content`,
      );
      return;
    }
  }

  try {
    await runTfrename(detection.kind, detection.oldName, result.newName, dir, result.moved);
  } catch (err) {
    vscode.window.showErrorMessage(`tfrename: ${formatError(err)}`);
    return;
  }
  const suffix = result.moved ? ' (with moved block)' : '';
  vscode.window.showInformationMessage(
    `tfrename: ${label} ${detection.oldName} -> ${result.newName}${suffix}`,
  );
}

interface PromptResult {
  newName: string;
  moved: boolean;
}

// promptNewName shows an input box for the new symbol name. For resource and
// module kinds, a button on the right of the input toggles whether tfrename
// should insert a `moved {}` block. The current toggle state is reflected in
// both the title bar and the button tooltip so it stays visible while typing.
function promptNewName(detection: Detection, defaultMoved: boolean): Promise<PromptResult | undefined> {
  const label = KIND_LABEL[detection.kind];
  const supportsMoved = detection.kind === 'resource' || detection.kind === 'module';
  let moved = supportsMoved && defaultMoved;

  const input = vscode.window.createInputBox();
  input.value = detection.oldName;
  input.valueSelection = selectionForRename(detection);
  input.prompt = `New name for ${label} ${detection.oldName}`;
  input.ignoreFocusOut = true;

  // QuickInputButton fields are read-only, so the button is recreated on every
  // refresh. Identity is checked in onDidTriggerButton by the iconPath value.
  const movedIcon = new vscode.ThemeIcon('arrow-swap');
  const refresh = () => {
    const movedLabel = moved ? 'ON' : 'OFF';
    input.title = supportsMoved
      ? `Rename ${label}  -  moved block: ${movedLabel}`
      : `Rename ${label}`;
    if (supportsMoved) {
      input.buttons = [
        {
          iconPath: movedIcon,
          tooltip: `moved block: ${movedLabel} (click to toggle)`,
        },
      ];
    }
  };
  refresh();

  const updateValidation = () => {
    const err = validateNewName(detection.kind, input.value);
    input.validationMessage = err ?? undefined;
  };
  updateValidation();

  return new Promise<PromptResult | undefined>((resolve) => {
    const disposables: vscode.Disposable[] = [];
    let settled = false;
    const finish = (value: PromptResult | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      input.hide();
    };

    disposables.push(
      input.onDidChangeValue(() => updateValidation()),
      input.onDidTriggerButton((b) => {
        if (b.iconPath === movedIcon) {
          moved = !moved;
          refresh();
        }
      }),
      input.onDidAccept(() => {
        if (validateNewName(detection.kind, input.value)) {
          updateValidation();
          return;
        }
        finish({ newName: input.value.trim(), moved: supportsMoved && moved });
      }),
      input.onDidHide(() => {
        finish(undefined);
        for (const d of disposables) {
          d.dispose();
        }
        input.dispose();
      }),
    );

    input.show();
  });
}

function detect(doc: vscode.TextDocument, sel: vscode.Selection): Detection | null {
  // 1. Explicit selection wins if it is a full reference token.
  if (!sel.isEmpty) {
    const text = doc.getText(sel).trim();
    const fromRef = detectFromRef(text);
    if (fromRef) {
      return fromRef;
    }
  }

  const line = doc.lineAt(sel.active.line).text;
  const col = sel.active.character;

  // 2. Cursor on a declaration line.
  const fromDecl = detectFromDecl(line);
  if (fromDecl) {
    return fromDecl;
  }

  // 3. Token under cursor matches a reference pattern.
  const token = tokenAt(line, col);
  const fromRef = detectFromRef(token);
  if (fromRef) {
    return fromRef;
  }

  // 4. Bare identifier on an assignment line inside `locals { ... }`.
  const fromLocal = detectLocalDecl(doc, sel.active.line, col);
  if (fromLocal) {
    return fromLocal;
  }

  return null;
}

function detectFromDecl(line: string): Detection | null {
  let m: RegExpExecArray | null;
  if ((m = reDeclResource.exec(line))) {
    return { kind: 'resource', oldName: `${m[1]}.${m[2]}` };
  }
  if ((m = reDeclData.exec(line))) {
    return { kind: 'data', oldName: `${m[1]}.${m[2]}` };
  }
  if ((m = reDeclModule.exec(line))) {
    return { kind: 'module', oldName: m[1] };
  }
  if ((m = reDeclVariable.exec(line))) {
    return { kind: 'variable', oldName: m[1] };
  }
  if ((m = reDeclOutput.exec(line))) {
    return { kind: 'output', oldName: m[1] };
  }
  return null;
}

// Built-in roots that look like resource references but are not renameable
// (each.key/value, count.index, path.module/root/cwd, terraform.workspace,
// self.* inside provisioners). Treating these as resources would just have
// tfrename emit a confusing "no matches found" error.
const BUILTIN_REF_ROOTS = new Set(['each', 'count', 'path', 'terraform', 'self']);

function detectFromRef(token: string): Detection | null {
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  if (!parts.every((p) => reIdent.test(p))) {
    return null;
  }
  const root = parts[0];
  if (root === 'var') {
    return { kind: 'variable', oldName: parts[1] };
  }
  if (root === 'local') {
    return { kind: 'local', oldName: parts[1] };
  }
  if (root === 'module') {
    return { kind: 'module', oldName: parts[1] };
  }
  if (root === 'data') {
    if (parts.length < 3) {
      return null;
    }
    return { kind: 'data', oldName: `${parts[1]}.${parts[2]}` };
  }
  if (BUILTIN_REF_ROOTS.has(root)) {
    return null;
  }
  return { kind: 'resource', oldName: `${root}.${parts[1]}` };
}

// detectLocalDecl handles the cursor sitting on an attribute name inside a
// `locals { ... }` block. It walks back through prior lines to find an
// unmatched `{` and checks that it belongs to a `locals` block.
function detectLocalDecl(
  doc: vscode.TextDocument,
  lineIdx: number,
  col: number,
): Detection | null {
  const line = doc.lineAt(lineIdx).text;
  const m = reLocalAttr.exec(line);
  if (!m) {
    return null;
  }
  const name = m[1];
  const start = line.indexOf(name);
  if (col < start || col > start + name.length) {
    return null;
  }
  let depth = 0;
  for (let i = lineIdx - 1; i >= 0; i--) {
    const text = doc.lineAt(i).text;
    for (let j = text.length - 1; j >= 0; j--) {
      const c = text[j];
      if (c === '}') {
        depth++;
      } else if (c === '{') {
        if (depth === 0) {
          const before = text.slice(0, j).trimEnd();
          if (/(^|\s)locals$/.test(before)) {
            return { kind: 'local', oldName: name };
          }
          return null;
        }
        depth--;
      }
    }
  }
  return null;
}

function tokenAt(line: string, col: number): string {
  const isTok = (c: string) => /[A-Za-z0-9_.-]/.test(c);
  let s = col;
  let e = col;
  while (s > 0 && isTok(line[s - 1])) {
    s--;
  }
  while (e < line.length && isTok(line[e])) {
    e++;
  }
  // Strip a trailing dot so partial tokens like "aws_instance." still match.
  let token = line.slice(s, e);
  while (token.endsWith('.')) {
    token = token.slice(0, -1);
  }
  while (token.startsWith('.')) {
    token = token.slice(1);
  }
  return token;
}

// selectionForRename pre-selects the name part of the prefilled input so the
// user can just type the new name. For TYPE.NAME forms, only NAME is selected.
function selectionForRename(d: Detection): [number, number] | undefined {
  if (d.kind === 'resource' || d.kind === 'data') {
    const dot = d.oldName.indexOf('.');
    if (dot >= 0) {
      return [dot + 1, d.oldName.length];
    }
  }
  return [0, d.oldName.length];
}

function validateNewName(kind: Kind, value: string): string | null {
  const v = value.trim();
  if (!v) {
    return 'name cannot be empty';
  }
  if (kind === 'resource' || kind === 'data') {
    const parts = v.split('.');
    if (parts.length !== 2 || !reIdent.test(parts[0]) || !reIdent.test(parts[1])) {
      return 'expected TYPE.NAME';
    }
    return null;
  }
  if (!reIdent.test(v)) {
    return 'expected a valid identifier';
  }
  return null;
}

function runTfrename(
  kind: Kind,
  oldName: string,
  newName: string,
  dir: string,
  moved: boolean,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('tfrename');
  const bin = cfg.get<string>('executable', 'tfrename');

  const args: string[] = [kind, oldName, newName, '-C', dir, '-i'];
  if (moved && (kind === 'resource' || kind === 'module')) {
    args.push('--moved');
  }

  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message).trim();
        reject(new Error(msg));
        return;
      }
      resolve();
    });
  });
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
