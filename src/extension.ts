import * as vscode from "vscode";
import { clearTimeout, setTimeout } from "node:timers";
import {
  collectRainbowDecorations,
  RainbowAnalysisOptions,
} from "./highlighter";

interface RainbowConfiguration extends RainbowAnalysisOptions {
  readonly enabled: boolean;
  readonly colors: readonly string[];
  readonly fontWeight: string;
  readonly supportedLanguages: readonly string[];
  readonly maxFileSizeKb: number;
}

class RainbowVariablesController implements vscode.Disposable {
  private decorationTypes: vscode.TextEditorDecorationType[] = [];
  private pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();
  private configuration = readConfiguration();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor() {
    this.rebuildDecorationTypes();
    this.registerListeners();
    this.refreshAllVisibleEditors();
  }

  public dispose(): void {
    for (const timeout of this.pendingUpdates.values()) {
      clearTimeout(timeout);
    }

    this.pendingUpdates.clear();
    this.disposeDecorationTypes();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  public isEnabled(): boolean {
    return this.configuration.enabled;
  }

  public refreshAllVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.updateEditor(editor);
    }
  }

  public showStatus(): void {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      vscode.window.showInformationMessage(
        "Rainbow Variables: no active editor to inspect.",
      );
      return;
    }

    const skipReason = this.getSkipReason(editor.document);
    if (skipReason) {
      this.clearEditor(editor);
      vscode.window.showWarningMessage(`Rainbow Variables: ${skipReason}`);
      return;
    }

    const decorations = collectRainbowDecorations(
      editor.document.getText(),
      editor.document.languageId,
      editor.document.fileName,
      this.configuration,
    );

    this.updateEditor(editor);
    vscode.window.showInformationMessage(
      `Rainbow Variables: highlighted ${decorations.length} identifiers in this ${editor.document.languageId} file.`,
    );
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() =>
        this.refreshAllVisibleEditors(),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.updateEditor(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === event.document) {
            this.scheduleEditorUpdate(editor);
          }
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("rainbowVariables")) {
          this.configuration = readConfiguration();
          this.rebuildDecorationTypes();
          this.refreshAllVisibleEditors();
        }
      }),
    );
  }

  private scheduleEditorUpdate(editor: vscode.TextEditor): void {
    const key = editor.document.uri.toString();
    const existingTimeout = this.pendingUpdates.get(key);

    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(() => {
      this.pendingUpdates.delete(key);
      this.updateEditor(editor);
    }, 80);

    this.pendingUpdates.set(key, timeout);
  }

  private updateEditor(editor: vscode.TextEditor): void {
    if (this.getSkipReason(editor.document)) {
      this.clearEditor(editor);
      return;
    }

    const text = editor.document.getText();
    const decorations = collectRainbowDecorations(
      text,
      editor.document.languageId,
      editor.document.fileName,
      this.configuration,
    );
    const rangesByColor = this.decorationTypes.map((): vscode.Range[] => []);

    for (const decoration of decorations) {
      const decorationTypeIndex =
        decoration.colorIndex % this.decorationTypes.length;
      rangesByColor[decorationTypeIndex].push(
        new vscode.Range(
          editor.document.positionAt(decoration.start),
          editor.document.positionAt(decoration.end),
        ),
      );
    }

    for (const [index, decorationType] of this.decorationTypes.entries()) {
      editor.setDecorations(decorationType, rangesByColor[index]);
    }
  }

  private getSkipReason(document: vscode.TextDocument): string | undefined {
    if (!this.configuration.enabled) {
      return "highlighting is disabled.";
    }

    if (this.decorationTypes.length === 0) {
      return "the color palette is empty.";
    }

    if (!this.configuration.supportedLanguages.includes(document.languageId)) {
      return `language '${document.languageId}' is not enabled.`;
    }

    if (document.getText().length > this.configuration.maxFileSizeKb * 1024) {
      return `file is larger than ${this.configuration.maxFileSizeKb} KB.`;
    }

    return undefined;
  }

  private clearEditor(editor: vscode.TextEditor): void {
    for (const decorationType of this.decorationTypes) {
      editor.setDecorations(decorationType, []);
    }
  }

  private rebuildDecorationTypes(): void {
    this.disposeDecorationTypes();

    this.decorationTypes = this.configuration.colors
      .filter((color) => color.trim().length > 0)
      .map((color) =>
        vscode.window.createTextEditorDecorationType({
          color,
          fontWeight: this.configuration.fontWeight,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
      );
  }

  private disposeDecorationTypes(): void {
    for (const decorationType of this.decorationTypes) {
      decorationType.dispose();
    }

    this.decorationTypes = [];
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new RainbowVariablesController();

  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("rainbowVariables.refresh", () =>
      controller.refreshAllVisibleEditors(),
    ),
    vscode.commands.registerCommand("rainbowVariables.showStatus", () =>
      controller.showStatus(),
    ),
    vscode.commands.registerCommand("rainbowVariables.toggle", async () => {
      await vscode.workspace
        .getConfiguration("rainbowVariables")
        .update(
          "enabled",
          !controller.isEnabled(),
          vscode.ConfigurationTarget.Global,
        );
    }),
  );
}

export function deactivate(): void {}

function readConfiguration(): RainbowConfiguration {
  const configuration = vscode.workspace.getConfiguration("rainbowVariables");

  return {
    enabled: configuration.get("enabled", true),
    colors: configuration.get("colors", [
      "#e06c75",
      "#d19a66",
      "#e5c07b",
      "#98c379",
      "#56b6c2",
      "#61afef",
      "#c678dd",
      "#be5046",
    ]),
    fontWeight: configuration.get("fontWeight", "600"),
    includeParameters: configuration.get("includeParameters", true),
    includeVariables: configuration.get("includeVariables", true),
    includeImports: configuration.get("includeImports", true),
    supportedLanguages: configuration.get("supportedLanguages", [
      "typescript",
      "typescriptreact",
      "javascript",
      "javascriptreact",
    ]),
    maxFileSizeKb: configuration.get("maxFileSizeKb", 512),
  };
}
