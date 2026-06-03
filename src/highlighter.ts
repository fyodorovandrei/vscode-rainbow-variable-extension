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

/**
 * Represents one node in the scope tree.
 *
 * Each scope holds its own `declarations` map and a reference to the enclosing
 * `parent`. Two distinct counter objects govern color assignment:
 * - `functionState` — shared by all lexical scopes inside the same function;
 *   resets to 0 at every function boundary so sibling functions get independent
 *   color sequences.
 * - `importState` — shared across the entire file so every import binding gets a
 *   unique, stable color regardless of where it is used.
 *
 * The root scope has `functionState = undefined`, which prevents top-level
 * declarations (outside any function) from being colored.
 */
class LexicalScope {
  private readonly declarations = new Map<string, DeclarationInfo>();

  public constructor(
    private readonly parent: LexicalScope | undefined,
    private readonly functionState: ColorState | undefined,
    private readonly functionBoundary: boolean,
    private readonly importState: ColorState,
  ) {}

  /**
   * Creates a child scope that begins a new function boundary.
   * A fresh `ColorState` is allocated so parameters and locals inside
   * the new function start their color sequence from index 0.
   */
  public createFunctionScope(): LexicalScope {
    return new LexicalScope(
      this,
      { nextColorIndex: 0 },
      true,
      this.importState,
    );
  }

  /**
   * Creates a child scope for a block (`{}`, `catch`, `for`, etc.) that
   * does NOT start a new function boundary.
   * The parent's `functionState` counter is inherited so block-scoped
   * declarations continue the same color sequence as the enclosing function.
   */
  public createLexicalScope(): LexicalScope {
    return new LexicalScope(this, this.functionState, false, this.importState);
  }

  /**
   * Registers a parameter or local variable declaration in this scope.
   *
   * No-ops when:
   * - the scope is the root (no `functionState` — top-level vars are not colored)
   * - `name` is in the ignored list (`arguments`, `undefined`)
   * - `name` is already declared in this exact scope (prevents duplicate color indices)
   *
   * The color index is taken from `functionState.nextColorIndex` and then incremented.
   */
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

  /**
   * Registers an import binding (default, namespace, or named) in this scope.
   *
   * Unlike `addDeclaration`, this uses the file-wide `importState` counter so
   * import colors are stable and independent of function scope boundaries.
   * No-ops if `name` is already declared (avoids duplicate entries).
   */
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

  /**
   * Walks up the scope chain and returns the first `DeclarationInfo` whose
   * `name` matches, or `undefined` if the name is not declared anywhere.
   */
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

  /**
   * Walks up the scope chain and returns the closest ancestor scope whose
   * `functionBoundary` flag is `true`, or `undefined` if there is none.
   * Used to hoist `var` declarations to their containing function scope.
   */
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

  /**
   * Returns `true` when this scope has an active `functionState`, i.e. it is
   * inside at least one function body and thus eligible to color declarations.
   * The root scope returns `false` so top-level declarations are skipped.
   */
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

/**
 * Entry point — parses `text` as a TypeScript/JavaScript source file and returns
 * every identifier that should receive a rainbow decoration.
 *
 * @param text       - Raw source text of the document.
 * @param languageId - VS Code language identifier (e.g. `"typescript"`, `"javascriptreact"`).
 * @param fileName   - File name used to infer the parser's script kind when `languageId`
 *                     is absent or ambiguous; falls back to a synthetic name if empty.
 * @param options    - Toggles for which declaration kinds (`parameter`, `variable`,
 *                     `import`) to include in the output.
 * @returns Sorted array of `RainbowDecoration` objects, one per colored identifier range.
 */
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

/**
 * Walks the TypeScript AST and constructs the full scope tree for `sourceFile`.
 *
 * The returned `ScopeModel` contains:
 * - `rootScope`   — the file-level scope (cannot color declarations directly).
 * - `nodeScopes`  — a `WeakMap` from function/block AST nodes to the scope
 *   created for that node, used later by `collectDecorations` to resolve names.
 *
 * Import declarations are always registered on `rootScope` so they are visible
 * throughout the file regardless of the position of their `import` statement.
 */
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

/**
 * Traverses the AST a second time, this time emitting `RainbowDecoration`
 * objects for every identifier that resolves to a tracked binding.
 *
 * A `seenRanges` set prevents duplicate entries for the same source range
 * (which can occur when TypeScript synthesises multiple identifier nodes for
 * the same token, e.g. in JSX spread or decorator positions).
 *
 * The result is sorted by `start` offset (then `end`) so callers can safely
 * binary-search or zip-iterate the decorations against the document text.
 */
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

/**
 * Returns `true` when the `options` flags allow the given declaration's kind
 * to be shown.
 * Maps `"import"` → `includeImports`, `"parameter"` → `includeParameters`,
 * and `"variable"` → `includeVariables`.
 */
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

/**
 * Determines which scope a `VariableDeclaration` should be registered in.
 *
 * - Block-scoped declarations (`const`, `let`) belong to the immediately
 *   enclosing lexical scope.
 * - Function-scoped declarations (`var`) are hoisted to the nearest enclosing
 *   function scope (or the current scope if no function scope is found).
 */
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

/**
 * Recursively collects every `Identifier` leaf from a binding pattern.
 *
 * Handles three forms:
 * - Simple identifier: `x` → calls `onIdentifier(x)` directly.
 * - Array pattern: `[a, , b]` → recurses into each non-omitted element.
 * - Object pattern: `{ p, q: r }` → recurses into each element's `name`.
 *
 * `OmittedExpression` elements (empty slots in array patterns) are skipped.
 */
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

/**
 * Type guard that matches any function-like AST node that has a body.
 *
 * Covers: `function` declarations, `function` expressions, arrow functions
 * (`=>`), method declarations, constructors, and getter/setter accessors.
 * Returns `false` for overload signatures (body is `undefined`).
 */
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

/**
 * Returns `true` for AST subtrees that contain only type-level syntax and
 * therefore need not be visited by `collectDecorations`.
 *
 * Skipping these subtrees avoids false positives where a type annotation
 * happens to reference an identifier whose name matches a local variable.
 * Covers: type nodes, `type` aliases, `interface` declarations, and
 * `export` declarations (whose specifiers are excluded by `isExportSpecifierName`).
 */
function shouldSkipSubtree(node: ts.Node): boolean {
  return (
    ts.isTypeNode(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isExportDeclaration(node)
  );
}

/**
 * Determines whether an identifier node should be given a rainbow color.
 *
 * An identifier is colored only when it resolves to a user-declared binding
 * (parameter, local variable, or import) and is used as a *value reference*.
 * The checks below strip every position where the identifier is a structural
 * part of syntax rather than a reference — e.g. a property key, a type name,
 * a label, or a JSX attribute name — so those positions are left untouched by
 * the extension and continue to show the theme color.
 */
function shouldDecorateIdentifier(identifier: ts.Identifier): boolean {
  if (!identifier.parent) {
    return false;
  }

  return (
    !isPropertyAccessName(identifier) && // a.b  A.B  — rhs not a ref
    !isObjectKeyOrPatternSourceName(identifier) && // {key:v}  {src:dest}
    !isMemberOrTypeLevelDeclarationName(identifier) && // class/type declaration-site names
    !isImportOriginalName(identifier) && // import { original as local }
    !isExportSpecifierName(identifier) && // export { x as y }
    !isLabelName(identifier) && // label:  break label  continue label
    !isJsxAttributeName(identifier) // <Comp propName={…}>
  );
}

/**
 * Returns true when the identifier is the *property* side of a member expression,
 * not the object being accessed.
 *   `obj.prop`   → `prop` is excluded; `obj` is still decorated.
 *   `Ns.Type`    → `Type` is excluded (qualified name right side).
 */
function isPropertyAccessName(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isQualifiedName(parent) && parent.right === identifier)
  );
}

/**
 * Returns true when the identifier is a static key inside an object literal
 * or the *source* (left) side of a rename in a destructuring pattern.
 *   `{ name: value }`    → `name` is excluded; `value` is still decorated.
 *   `const { src: dest }` → `src` is excluded; `dest` is still decorated.
 */
function isObjectKeyOrPatternSourceName(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return (
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier)
  );
}

/**
 * Returns true when the identifier is the declared *name* of a class member,
 * type-level construct, or similar structural position — never a value reference.
 */
function isMemberOrTypeLevelDeclarationName(
  identifier: ts.Identifier,
): boolean {
  const { parent } = identifier;
  return (
    // Class instance / prototype member names: `class C { field = 1; method() {} get x() {} set x(v) {} }`
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isMethodSignature(parent) && parent.name === identifier) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === identifier) ||
    // Type-level declaration names: `class C`, `interface I`, `type T`, `enum E { member }`, `<T>`
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === identifier) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === identifier) ||
    (ts.isEnumMember(parent) && parent.name === identifier) ||
    (ts.isTypeParameterDeclaration(parent) && parent.name === identifier)
  );
}

/**
 * Returns true when the identifier is the *source* name in a renamed import specifier.
 *   `import { readFile as read }` → `readFile` is excluded; `read` is still decorated.
 * Non-renamed specifiers (`import { useState }`) have no propertyName, so they pass through.
 */
function isImportOriginalName(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return ts.isImportSpecifier(parent) && parent.propertyName === identifier;
}

/**
 * Returns true when the identifier appears inside an export specifier.
 *   `export { localVar as publicName }` → both `localVar` and `publicName` are excluded.
 * These positions re-export an existing binding; coloring them separately would
 * create a second, unrelated color index for the same value.
 */
function isExportSpecifierName(identifier: ts.Identifier): boolean {
  return ts.isExportSpecifier(identifier.parent);
}

/**
 * Returns true when the identifier is a statement label — not a variable.
 *   `outer: for (…) { break outer; continue outer; }`
 * Labels occupy their own syntax namespace and have no binding in scope.
 */
function isLabelName(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return (
    (ts.isLabeledStatement(parent) ||
      ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent)) &&
    parent.label === identifier
  );
}

/**
 * Returns true when the identifier is the *name* of a JSX attribute.
 *   `<Button label="Save" onClick={fn} />` → `label` and `onClick` are excluded.
 * JSX component tag names (e.g. `Button` in `<Button>`) are NOT excluded here
 * so imported component references keep their rainbow color at usage sites.
 */
function isJsxAttributeName(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return ts.isJsxAttribute(parent) && parent.name === identifier;
}

/**
 * Maps a VS Code `languageId` to the TypeScript compiler's `ScriptKind`
 * enum value so the parser handles JSX syntax correctly.
 * Defaults to `TS` for unknown language IDs.
 */
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

/**
 * Returns a synthetic file name with the correct extension for `languageId`.
 * Used when no real file name is available (e.g. untitled buffers) so the
 * TypeScript compiler infers the correct `ScriptKind` from the extension.
 */
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

/**
 * Registers every binding introduced by a single `import` statement into `scope`.
 *
 * Handles all three binding forms:
 * - Default import:    `import React from "react"`        → `React`
 * - Namespace import:  `import * as fs from "fs"`          → `fs`
 * - Named imports:     `import { a, b as c } from "./m"`   → `a`, `c`
 *   (the original name `b` is the `propertyName` and is excluded via `isImportOriginalName`)
 *
 * Side-effect-only imports (`import "./styles.css"`) have no `importClause`
 * and are silently skipped.
 */
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
