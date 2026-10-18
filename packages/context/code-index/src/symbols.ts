/**
 * TypeScript AST symbol extraction for the code index.
 *
 * Declarations are collected by walking the AST produced by
 * `ts.createSourceFile`; no regular expressions are involved.
 * @module @deepseek-ai/dsh-code-index/symbols
 */

import ts from 'typescript'

/** Declaration forms the extractor records. */
export type SymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'variable'

/** One named declaration with its source location. */
export interface CodeSymbol {
  /** Declared name. */
  name: string
  /** Declaration form. */
  kind: SymbolKind
  /** 1-based source line of the name. */
  line: number
}

/** TypeScript script kinds by file suffix. */
const SCRIPT_KIND_BY_EXTENSION: Readonly<Record<string, ts.ScriptKind>> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
}

/**
 * Collect named declarations from one source file. Overload signatures and
 * re-declarations each contribute a symbol at their own line; declaration-less
 * or destructuring-only statements contribute nothing. Parsing is
 * error-tolerant: a file that does not parse yields whatever the recovery AST
 * contains.
 * @param source - raw file text.
 * @param fileName - path used only for script-kind selection.
 * @returns extracted declarations in source order.
 */
export function extractSymbols(source: string, fileName: string): CodeSymbol[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName))
  const symbols: CodeSymbol[] = []
  const visit = (node: ts.Node): void => {
    const symbol = symbolFor(node, sourceFile)
    if (symbol !== undefined) symbols.push(symbol)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return symbols
}

/** Resolve the script kind for one path suffix, defaulting to plain TypeScript. */
function scriptKindFor(fileName: string): ts.ScriptKind {
  const dot = fileName.lastIndexOf('.')
  const extension = dot < 0 ? '' : fileName.slice(dot).toLowerCase()
  return SCRIPT_KIND_BY_EXTENSION[extension] ?? ts.ScriptKind.TS
}

/** Extract one symbol from a declaration node, or undefined for unsupported forms. */
function symbolFor(node: ts.Node, sourceFile: ts.SourceFile): CodeSymbol | undefined {
  if (ts.isFunctionDeclaration(node)) return namedSymbol(node.name, 'function', sourceFile)
  if (ts.isMethodDeclaration(node)) return namedSymbol(identifierName(node.name), 'method', sourceFile)
  if (ts.isClassDeclaration(node)) return namedSymbol(node.name, 'class', sourceFile)
  if (ts.isInterfaceDeclaration(node)) return namedSymbol(node.name, 'interface', sourceFile)
  if (ts.isTypeAliasDeclaration(node)) return namedSymbol(node.name, 'type', sourceFile)
  if (ts.isEnumDeclaration(node)) return namedSymbol(node.name, 'enum', sourceFile)
  if (ts.isVariableStatement(node)) return firstVariableSymbol(node, sourceFile)
  return undefined
}

/** Identifier or string form of a method name; computed or private names name no symbol. */
function identifierName(name: ts.PropertyName): ts.Identifier | ts.StringLiteral | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name : undefined
}

/** Build one symbol from a name, or undefined when the name is absent. */
function namedSymbol(
  name: ts.Identifier | ts.StringLiteral | undefined,
  kind: SymbolKind,
  sourceFile: ts.SourceFile,
): CodeSymbol | undefined {
  if (name === undefined) return undefined
  // A string-literal method name keeps its declared text; TS 6 reports it without the quotes.
  return { name: name.text, kind, line: lineOf(name, sourceFile) }
}

/** Extract the first eligible named variable from a `const`/`let`/`var` statement. */
function firstVariableSymbol(statement: ts.VariableStatement, sourceFile: ts.SourceFile): CodeSymbol | undefined {
  for (const declaration of statement.declarationList.declarations) {
    // Destructuring bindings name no single symbol; later declarations stay eligible.
    if (!ts.isIdentifier(declaration.name)) continue
    return {
      name: declaration.name.text,
      kind: 'variable',
      line: lineOf(declaration.name, sourceFile),
    }
  }
  return undefined
}

/** 1-based source line of one name occurrence. */
function lineOf(name: ts.Identifier | ts.StringLiteral, sourceFile: ts.SourceFile): number {
  return ts.getLineAndCharacterOfPosition(sourceFile, name.getStart(sourceFile)).line + 1
}
