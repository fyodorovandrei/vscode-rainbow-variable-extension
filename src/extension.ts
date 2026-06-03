import * as vscode from "vscode";
import { clearTimeout, setTimeout } from "node:timers";
import {
  collectRainbowDecorations,
  RainbowAnalysisOptions,
  RainbowDecoration,
} from "./highlighter";
import packageJson from "../package.json";

const DEFAULT_COLORS: string[] =
  packageJson.contributes.configuration.properties["rainbowVariables.colors"]
    .default;

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

    this.ensureDecorationTypesForDecorations(decorations);
    const rangesByColor = this.decorationTypes.map((): vscode.Range[] => []);

    for (const decoration of decorations) {
      const decorationTypeIndex = decoration.declarationId;
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

    this.ensureDecorationTypes(this.configuration.colors.length - 1);
  }

  private ensureDecorationTypesForDecorations(
    decorations: readonly RainbowDecoration[],
  ): void {
    let highestDeclarationId = -1;

    for (const decoration of decorations) {
      if (decoration.declarationId > highestDeclarationId) {
        highestDeclarationId = decoration.declarationId;
      }
    }

    this.ensureDecorationTypes(highestDeclarationId);
  }

  private ensureDecorationTypes(maxIndex: number): void {
    if (maxIndex < 0) {
      return;
    }

    while (this.decorationTypes.length <= maxIndex) {
      const color = this.getColorForDecorationIndex(
        this.decorationTypes.length,
      );
      this.decorationTypes.push(
        vscode.window.createTextEditorDecorationType({
          color,
          fontWeight: this.configuration.fontWeight,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
      );
    }
  }

  private getColorForDecorationIndex(index: number): string {
    const configuredColors = this.configuration.colors.filter(
      (color) => color.trim().length > 0,
    );

    if (index < configuredColors.length) {
      return configuredColors[index];
    }

    const generatedIndex = index - configuredColors.length;

    // Skip red/orange/yellow range (0-60°) to avoid confusion with error/warning colors.
    // Use a golden-angle distribution over the safe range (60-360°).
    const safeHueRange = 300; // degrees (360 - 60)
    const baseHue = 60; // start after red/orange/yellow
    const hue = Math.floor((generatedIndex * 137.508) % safeHueRange) + baseHue;

    const saturation = 70;
    const lightness = 55 + ((generatedIndex % 4) - 1) * 6;

    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
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
    colors: configuration.get("colors", DEFAULT_COLORS),
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
