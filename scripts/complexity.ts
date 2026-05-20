import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

type FunctionMetric = {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  lines: number;
  cyclomatic: number;
  maxNesting: number;
};

type FileMetric = {
  file: string;
  functions: number;
  maxCyclomatic: number;
  maxNesting: number;
  maxLines: number;
};

type ComplexityReport = {
  generatedAt: string;
  root: string;
  sourceGlobs: string[];
  totals: {
    files: number;
    functions: number;
    maxCyclomatic: number;
    maxNesting: number;
    maxLines: number;
  };
  files: FileMetric[];
  functions: FunctionMetric[];
};

const root = process.cwd();
const sourceGlobs = ["src/**/*.ts"];
const outputPath = path.join(root, "reports", "complexity.json");
const topCount = 20;

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
if (configPath === undefined) {
  throw new Error("Unable to find tsconfig.json");
}

const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error !== undefined) {
  throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
}

const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const sourceFiles = program
  .getSourceFiles()
  .filter((sourceFile) => isProjectSourceFile(sourceFile.fileName));
if (sourceFiles.length === 0) {
  throw new Error("No source files matched src/**/*.ts");
}

const functions = sourceFiles
  .flatMap((sourceFile) => collectFunctionMetrics(sourceFile))
  .sort(compareFunctions);
const files = summarizeFiles(sourceFiles, functions);
const report: ComplexityReport = {
  generatedAt: new Date().toISOString(),
  root,
  sourceGlobs,
  totals: {
    files: files.length,
    functions: functions.length,
    maxCyclomatic: max(functions.map((metric) => metric.cyclomatic)),
    maxNesting: max(functions.map((metric) => metric.maxNesting)),
    maxLines: max(functions.map((metric) => metric.lines)),
  },
  files,
  functions,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
printReport(report);

function isProjectSourceFile(fileName: string): boolean {
  const relative = normalizeRelativePath(fileName);
  return relative.startsWith("src/") && relative.endsWith(".ts") && !relative.endsWith(".d.ts");
}

function collectFunctionMetrics(sourceFile: ts.SourceFile): FunctionMetric[] {
  const metrics: FunctionMetric[] = [];

  function visit(node: ts.Node): void {
    if (isFunctionLikeWithBody(node)) {
      metrics.push(measureFunction(sourceFile, node));
      ts.forEachChild(node.body, visit);
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return metrics;
}

function measureFunction(
  sourceFile: ts.SourceFile,
  node: ts.FunctionLikeDeclaration & { body: ts.ConciseBody },
): FunctionMetric {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const state = {
    cyclomatic: 1,
    maxNesting: 0,
  };

  measureNode(node.body, 0, state);

  return {
    name: functionName(sourceFile, node),
    file: normalizeRelativePath(sourceFile.fileName),
    startLine: start.line + 1,
    endLine: end.line + 1,
    lines: end.line - start.line + 1,
    cyclomatic: state.cyclomatic,
    maxNesting: state.maxNesting,
  };
}

function measureNode(
  node: ts.Node,
  nesting: number,
  state: { cyclomatic: number; maxNesting: number },
): void {
  if (isNestedFunction(node)) {
    return;
  }

  if (ts.isIfStatement(node)) {
    state.cyclomatic += 1;
    const childNesting = nesting + 1;
    state.maxNesting = Math.max(state.maxNesting, childNesting);

    measureNode(node.expression, nesting, state);
    measureNode(node.thenStatement, childNesting, state);
    if (node.elseStatement !== undefined) {
      measureNode(
        node.elseStatement,
        ts.isIfStatement(node.elseStatement) ? nesting : childNesting,
        state,
      );
    }
    return;
  }

  if (addsDecisionPoint(node)) {
    state.cyclomatic += 1;
  }

  if (ts.isBinaryExpression(node) && isShortCircuitOperator(node.operatorToken.kind)) {
    state.cyclomatic += 1;
  }

  const childNesting = addsNesting(node) ? nesting + 1 : nesting;
  state.maxNesting = Math.max(state.maxNesting, childNesting);

  ts.forEachChild(node, (child) => measureNode(child, childNesting, state));
}

function summarizeFiles(sourceFiles: ts.SourceFile[], functions: FunctionMetric[]): FileMetric[] {
  const byFile = new Map<string, FunctionMetric[]>();
  for (const metric of functions) {
    byFile.set(metric.file, [...(byFile.get(metric.file) ?? []), metric]);
  }

  return sourceFiles
    .map((sourceFile) => {
      const file = normalizeRelativePath(sourceFile.fileName);
      const fileFunctions = byFile.get(file) ?? [];
      return {
        file,
        functions: fileFunctions.length,
        maxCyclomatic: max(fileFunctions.map((metric) => metric.cyclomatic)),
        maxNesting: max(fileFunctions.map((metric) => metric.maxNesting)),
        maxLines: max(fileFunctions.map((metric) => metric.lines)),
      };
    })
    .sort(
      (left, right) =>
        right.maxCyclomatic - left.maxCyclomatic ||
        right.maxNesting - left.maxNesting ||
        right.maxLines - left.maxLines ||
        left.file.localeCompare(right.file),
    );
}

function isFunctionLikeWithBody(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.body !== undefined;
  }

  return false;
}

function isNestedFunction(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function addsDecisionPoint(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCatchClause(node)
  );
}

function addsNesting(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isCatchClause(node)
  );
}

function isShortCircuitOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function functionName(sourceFile: ts.SourceFile, node: ts.FunctionLikeDeclaration): string {
  if ("name" in node && node.name !== undefined) {
    return node.name.getText(sourceFile);
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (parent !== undefined && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
  }

  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }

  return "<anonymous>";
}

function compareFunctions(left: FunctionMetric, right: FunctionMetric): number {
  return (
    right.cyclomatic - left.cyclomatic ||
    right.maxNesting - left.maxNesting ||
    right.lines - left.lines ||
    left.file.localeCompare(right.file) ||
    left.startLine - right.startLine
  );
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function printReport(report: ComplexityReport): void {
  process.stdout.write("Complexity report\n");
  process.stdout.write(`Files: ${report.totals.files}\n`);
  process.stdout.write(`Functions: ${report.totals.functions}\n`);
  process.stdout.write(`Max cyclomatic: ${report.totals.maxCyclomatic}\n`);
  process.stdout.write(`Max nesting: ${report.totals.maxNesting}\n`);
  process.stdout.write(`Max function lines: ${report.totals.maxLines}\n`);
  process.stdout.write(`JSON: ${path.relative(root, outputPath)}\n\n`);
  process.stdout.write(`Top ${Math.min(topCount, report.functions.length)} functions\n`);
  process.stdout.write("cyc nest lines location\n");

  for (const metric of report.functions.slice(0, topCount)) {
    process.stdout.write(
      `${pad(metric.cyclomatic, 3)} ${pad(metric.maxNesting, 4)} ${pad(metric.lines, 5)} ${metric.file}:${metric.startLine} ${metric.name}\n`,
    );
  }
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, " ");
}

function normalizeRelativePath(fileName: string): string {
  return path.relative(root, fileName).replaceAll("\\", "/");
}
