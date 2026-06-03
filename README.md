# Rainbow Variables

Rainbow Variables colors parameters and local variables with a repeatable rainbow palette inside each JavaScript or TypeScript function/method scope. It is inspired by the JetBrains Rainbow Variable plugin and brings the same quick visual distinction to VS Code.

## Features

- Gives every method/function parameter and local variable a stable color within its scope.
- Reuses the surrounding function's color for captured variables inside nested functions.
- Starts a fresh color sequence for nested functions, lambdas, and class methods.
- Skips property names, imports, type-only syntax, and unsupported language documents.
- Updates highlights as you edit and exposes refresh/toggle commands in the Command Palette.

## Supported Languages

- JavaScript
- JavaScript React
- TypeScript
- TypeScript React

## Extension Settings

This extension contributes these settings:

- `rainbowVariables.enabled`: Enable or disable highlighting.
- `rainbowVariables.colors`: Palette used for parameters and variables.
- `rainbowVariables.fontWeight`: Font weight applied to highlighted identifiers.
- `rainbowVariables.includeParameters`: Color function and method parameters.
- `rainbowVariables.includeVariables`: Color local variables declared inside functions and methods.
- `rainbowVariables.includeImports`: Color imported bindings and their usages.
- `rainbowVariables.supportedLanguages`: VS Code language IDs where highlighting runs.
- `rainbowVariables.maxFileSizeKb`: Skip highlighting very large files.

## Commands

- `Rainbow Variables: Refresh`
- `Rainbow Variables: Show Status`
- `Rainbow Variables: Toggle`

Use `Rainbow Variables: Show Status` after installing if highlights are not visible. It reports whether the active editor is skipped and how many identifiers were found.

## Development

Run these from the extension root:

```sh
npm run compile
npm test
```

To make a local VSIX for installation, run:

```sh
npm run package:vsix
```

After installing the VSIX, reload VS Code so the new extension host loads the updated bundle.

## Known Issues

The first version uses TypeScript's parser for JavaScript and TypeScript files. Other languages can be added later with language-specific parsers or token providers.

## Release Notes

### 0.0.1

Initial Rainbow Variables implementation for JavaScript and TypeScript.
