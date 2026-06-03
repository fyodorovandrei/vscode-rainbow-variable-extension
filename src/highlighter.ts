import * as ts from "typescript";

export type RainbowIdentifierKind = "parameter" | "variable" | "import";

export interface RainbowDecoration {
  readonly name: string;
  readonly kind: RainbowIdentifierKind;
  readonly colorIndex: number;
  readonly start: number;
  readonly end: number;
}

export interface RainbowAnalysisOptions {
  readonly includeParameters: boolean;
  readonly includeVariables: boolean;
  readonly includeImports: boolean;
}

interface ColorState {
  nextColorIndex: number;
}

interface DeclarationInfo {
  readonly name: string;
  readonly kind: RainbowIdentifierKind;
  readonly colorIndex: number;
}

class LexicalScope {
  private readonly declarations = new Map<string, DeclarationInfo>();

  public constructor(
    private readonly parent: LexicalScope | undefined,
    private readonly functionState: ColorState | undefined,
    private readonly functionBoundary: boolean,
    private readonly importState: ColorState,
  ) {}

  public createFunctionScope(): LexicalScope {
    return new LexicalScope(
      this,
      { nextColorIndex: 0 },
      true,
      this.importState,
    );
  }

  public createLexicalScope(): LexicalScope {
    return new LexicalScope(this, this.functionState, false, this.importState);
  }

  public addDeclaration(name: string, kind: RainbowIdentifierKind): void {
    if (
      !this.functionState ||
      ignoredIdentifiers.has(name) ||
      this.declarations.has(name)
    ) {
      return;
    }

    const colorIndex = this.functionState.nextColorIndex;
    this.functionState.nextColorIndex += 1;

    this.declarations.set(name, {
      name,
      kind,
      colorIndex,
    });
  }

  public addImportDeclaration(name: string): void {
    if (ignoredIdentifiers.has(name) || this.declarations.has(name)) {
      return;
    }

    const colorIndex = this.importState.nextColorIndex;
    this.importState.nextColorIndex += 1;

    this.declarations.set(name, {
      name,
      kind: "import",
      colorIndex,
    });
  }

  public resolve(name: string): DeclarationInfo | undefined {
    let scope: LexicalScope | undefined = this;

    while (scope) {
      const declaration = scope.declarations.get(name);
      if (declaration) {
        return declaration;
      }

      scope = scope.parent;
    }

    return undefined;
  }

  public nearestFunctionScope(): LexicalScope | undefined {
    let scope: LexicalScope | undefined = this;

    while (scope) {
      if (scope.functionBoundary) {
        return scope;
      }

      scope = scope.parent;
    }

    return undefined;
  }

  public canColorDeclarations(): boolean {
    return Boolean(this.functionState);
  }
}

interface ScopeModel {
  readonly sourceFile: ts.SourceFile;
  readonly rootScope: LexicalScope;
  readonly nodeScopes: WeakMap<ts.Node, LexicalScope>;
}

const ignoredIdentifiers = new Set(["arguments", "undefined"]);

export function collectRainbowDecorations(
  text: string,
  languageId: string,
  fileName: string,
  options: RainbowAnalysisOptions,
): RainbowDecoration[] {
  const sourceFile = ts.createSourceFile(
    fileName || getFallbackFileName(languageId),
    text,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(languageId),
  );
  const scopeModel = buildScopeModel(sourceFile);

  return collectDecorations(scopeModel, options);
}

function buildScopeModel(sourceFile: ts.SourceFile): ScopeModel {
  const rootScope = new LexicalScope(undefined, undefined, false, {
    nextColorIndex: 0,
  });
  const nodeScopes = new WeakMap<ts.Node, LexicalScope>();
  nodeScopes.set(sourceFile, rootScope);

  function visit(node: ts.Node, scope: LexicalScope): void {
    if (ts.isImportDeclaration(node)) {
      registerImportDeclaration(node, rootScope);
    }

    if (ts.isImportEqualsDeclaration(node)) {
      rootScope.addImportDeclaration(node.name.text);
    }

    if (scope.canColorDeclarations()) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        scope.addDeclaration(node.name.text, "variable");
      } else if (ts.isClassDeclaration(node) && node.name) {
        scope.addDeclaration(node.name.text, "variable");
      }
    }

    if (isFunctionLikeWithBody(node)) {
      const functionScope = scope.createFunctionScope();
      nodeScopes.set(node, functionScope);

      if (ts.isFunctionExpression(node) && node.name) {
        functionScope.addDeclaration(node.name.text, "variable");
      }

      for (const parameter of node.parameters) {
        collectBindingIdentifiers(parameter.name, (identifier) =>
          functionScope.addDeclaration(identifier.text, "parameter"),
        );

        if (parameter.initializer) {
          visit(parameter.initializer, functionScope);
        }
      }

      visit(node.body, functionScope);
      return;
    }

    if (ts.isBlock(node) && scope.canColorDeclarations()) {
      const blockScope = scope.createLexicalScope();
      nodeScopes.set(node, blockScope);
      ts.forEachChild(node, (child) => visit(child, blockScope));
      return;
    }

    if (ts.isCatchClause(node) && scope.canColorDeclarations()) {
      const catchScope = scope.createLexicalScope();
      nodeScopes.set(node, catchScope);

      if (node.variableDeclaration) {
        collectBindingIdentifiers(node.variableDeclaration.name, (identifier) =>
          catchScope.addDeclaration(identifier.text, "variable"),
        );
      }

      ts.forEachChild(node, (child) => visit(child, catchScope));
      return;
    }

    if (scope.canColorDeclarations() && ts.isVariableDeclaration(node)) {
      const targetScope = getVariableDeclarationScope(node, scope);
      collectBindingIdentifiers(node.name, (identifier) =>
        targetScope.addDeclaration(identifier.text, "variable"),
      );
    }

    ts.forEachChild(node, (child) => visit(child, scope));
  }

  visit(sourceFile, rootScope);

  return {
    sourceFile,
    rootScope,
    nodeScopes,
  };
}

function collectDecorations(
  scopeModel: ScopeModel,
  options: RainbowAnalysisOptions,
): RainbowDecoration[] {
  const decorations: RainbowDecoration[] = [];
  const seenRanges = new Set<string>();

  function visit(node: ts.Node, scope: LexicalScope): void {
    if (isFunctionLikeWithBody(node)) {
      const functionScope = scopeModel.nodeScopes.get(node);
      if (!functionScope) {
        return;
      }

      for (const parameter of node.parameters) {
        visit(parameter, functionScope);
      }

      visit(node.body, functionScope);
      return;
    }

    const scopedNode = scopeModel.nodeScopes.get(node);
    if (scopedNode && scopedNode !== scope) {
      scope = scopedNode;
    }

    if (shouldSkipSubtree(node)) {
      return;
    }

    if (ts.isIdentifier(node) && shouldDecorateIdentifier(node)) {
      const declaration = scope.resolve(node.text);
      if (declaration && shouldIncludeDeclaration(declaration, options)) {
        const start = node.getStart(scopeModel.sourceFile);
        const end = node.getEnd();
        const key = `${start}:${end}`;

        if (!seenRanges.has(key)) {
          seenRanges.add(key);
          decorations.push({
            name: declaration.name,
            kind: declaration.kind,
            colorIndex: declaration.colorIndex,
            start,
            end,
          });
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, scope));
  }

  visit(scopeModel.sourceFile, scopeModel.rootScope);

  return decorations.sort(
    (first, second) => first.start - second.start || first.end - second.end,
  );
}

function shouldIncludeDeclaration(
  declaration: DeclarationInfo,
  options: RainbowAnalysisOptions,
): boolean {
  if (declaration.kind === "import") {
    return options.includeImports;
  }

  if (declaration.kind === "parameter") {
    return options.includeParameters;
  }

  return options.includeVariables;
}

function getVariableDeclarationScope(
  node: ts.VariableDeclaration,
  scope: LexicalScope,
): LexicalScope {
  const flags = ts.getCombinedNodeFlags(node);
  const isBlockScoped = (flags & ts.NodeFlags.BlockScoped) !== 0;

  if (isBlockScoped) {
    return scope;
  }

  return scope.nearestFunctionScope() ?? scope;
}

function collectBindingIdentifiers(
  name: ts.BindingName,
  onIdentifier: (identifier: ts.Identifier) => void,
): void {
  if (ts.isIdentifier(name)) {
    onIdentifier(name);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }

    collectBindingIdentifiers(element.name, onIdentifier);
  }
}

function isFunctionLikeWithBody(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    Boolean(node.body)
  );
}

function shouldSkipSubtree(node: ts.Node): boolean {
  return (
    ts.isTypeNode(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isExportDeclaration(node)
  );
}

function shouldDecorateIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;

  if (!parent) {
    return false;
  }

  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isQualifiedName(parent) && parent.right === identifier) {
    return false;
  }

  if (ts.isPropertyAssignment(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isBindingElement(parent) && parent.propertyName === identifier) {
    return false;
  }

  if (ts.isPropertyDeclaration(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isPropertySignature(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isMethodDeclaration(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isMethodSignature(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isGetAccessorDeclaration(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isSetAccessorDeclaration(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isClassDeclaration(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isInterfaceDeclaration(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isTypeAliasDeclaration(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isEnumMember(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isTypeParameterDeclaration(parent) && parent.name === identifier) {
    return false;
  }

  if (ts.isImportClause(parent)) {
    return parent.name === identifier;
  }

  if (ts.isImportSpecifier(parent)) {
    return parent.name === identifier;
  }

  if (ts.isNamespaceImport(parent)) {
    return parent.name === identifier;
  }

  if (ts.isImportEqualsDeclaration(parent)) {
    return parent.name === identifier;
  }

  if (ts.isExportSpecifier(parent)) {
    return false;
  }

  if (
    (ts.isLabeledStatement(parent) ||
      ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent)) &&
    parent.label === identifier
  ) {
    return false;
  }

  if (isJsxName(identifier)) {
    return false;
  }

  return true;
}

function isJsxName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;

  return (
    (ts.isJsxOpeningElement(parent) && parent.tagName === identifier) ||
    (ts.isJsxClosingElement(parent) && parent.tagName === identifier) ||
    (ts.isJsxSelfClosingElement(parent) && parent.tagName === identifier) ||
    (ts.isJsxAttribute(parent) && parent.name === identifier)
  );
}

function getScriptKind(languageId: string): ts.ScriptKind {
  switch (languageId) {
    case "javascriptreact":
      return ts.ScriptKind.JSX;
    case "typescriptreact":
      return ts.ScriptKind.TSX;
    case "javascript":
      return ts.ScriptKind.JS;
    case "typescript":
    default:
      return ts.ScriptKind.TS;
  }
}

function getFallbackFileName(languageId: string): string {
  switch (languageId) {
    case "javascriptreact":
      return "untitled.jsx";
    case "typescriptreact":
      return "untitled.tsx";
    case "javascript":
      return "untitled.js";
    case "typescript":
    default:
      return "untitled.ts";
  }
}

function registerImportDeclaration(
  node: ts.ImportDeclaration,
  scope: LexicalScope,
): void {
  const importClause = node.importClause;

  if (!importClause) {
    return;
  }

  if (importClause.name) {
    scope.addImportDeclaration(importClause.name.text);
  }

  if (!importClause.namedBindings) {
    return;
  }

  if (ts.isNamespaceImport(importClause.namedBindings)) {
    scope.addImportDeclaration(importClause.namedBindings.name.text);
    return;
  }

  for (const importSpecifier of importClause.namedBindings.elements) {
    scope.addImportDeclaration(importSpecifier.name.text);
  }
}
