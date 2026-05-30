# vscode-tfrename

[![CI](https://github.com/winebarrel/vscode-tfrename/actions/workflows/ci.yml/badge.svg)](https://github.com/winebarrel/vscode-tfrename/actions/workflows/ci.yml)
[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-tfrename-blue)](https://marketplace.visualstudio.com/items?itemName=winebarrel.vscode-tfrename)
[![AI Generated](https://img.shields.io/badge/AI%20Generated-Claude-orange?logo=anthropic)](https://claude.ai/claude-code)

A VS Code extension that renames Terraform resources, data sources, modules,
variables, outputs, and locals across the current directory by driving the
[`tfrename`](https://github.com/winebarrel/tfrename) CLI.

![](https://github.com/user-attachments/assets/b9ecd6dd-395f-4aeb-9d4a-4bfbfed0d7f2)
![](https://github.com/user-attachments/assets/63e63bbc-b147-4c64-b31f-7d0f925488f1)


## Requirements

`tfrename` must be installed and on your `PATH`:

```sh
brew install winebarrel/tfrename/tfrename
```

If the binary lives elsewhere, set `tfrename.executable` to its absolute path.

## Usage

1. Open a `.tf` file.
2. Place the cursor on, or select, the symbol you want to rename.
3. Right-click and pick `tfrename: Rename Terraform Symbol`, or run the same
   command from the Command Palette.
4. Enter the new name in the input box and press Enter.

The extension saves the active file, then runs `tfrename` in the directory of
that file with `-i` (in-place). Every `*.tf` file in that directory is
considered, so cross-file references are rewritten too.

## What gets detected

The extension picks the symbol kind from the cursor or selection.

| Cursor position or selection                | Kind     | Old name passed to tfrename |
| ------------------------------------------- | -------- | --------------------------- |
| `resource "aws_instance" "web"` (label)     | resource | `aws_instance.web`          |
| `data "aws_ami" "ubuntu"` (label)           | data     | `aws_ami.ubuntu`            |
| `module "vpc"` (label)                      | module   | `vpc`                       |
| `variable "region"` (label)                 | variable | `region`                    |
| `output "id"` (label)                       | output   | `id`                        |
| `env = "prod"` inside `locals { ... }`      | local    | `env`                       |
| `aws_instance.web` reference                | resource | `aws_instance.web`          |
| `data.aws_ami.ubuntu` reference             | data     | `aws_ami.ubuntu`            |
| `module.vpc` reference                      | module   | `vpc`                       |
| `var.region` reference                      | variable | `region`                    |
| `local.env` reference                       | local    | `env`                       |

For resources and data sources, the new name must also be in `TYPE.NAME` form,
which lets you change the type at the same time (e.g. `aws_instance.web` ->
`aws_db_instance.web`).

## `moved {}` block

When renaming a resource or module, the input box shows a toggle button on
the right. Click it to switch `moved block: ON` / `OFF`; the title bar
reflects the current state. With `ON`, `tfrename` is invoked with `--moved`,
which inserts a `moved {}` block so Terraform treats the rename as a state
move instead of destroy+create.

The default state of the toggle comes from the `tfrename.moved` setting.
Other kinds do not show the button.

## Settings

| Key                   | Default     | Description                                                              |
| --------------------- | ----------- | ------------------------------------------------------------------------ |
| `tfrename.executable` | `tfrename`  | Path to the tfrename binary. Looked up via PATH if not absolute.         |
| `tfrename.moved`      | `false`     | Default toggle state for the `moved {}` block on resource / module renames. |

## Notes

- The rename runs across every `*.tf` file in the directory of the active
  file. Sub-directories are not touched.
- The active document is saved before `tfrename` runs, since the CLI reads
  from disk.
- If `tfrename` finds no match or fails to parse a file, the extension shows
  the error message and leaves the files untouched.
