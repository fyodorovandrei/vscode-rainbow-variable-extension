import * as assert from "assert";
import { collectRainbowDecorations, RainbowDecoration } from "../highlighter";

suite("Extension Test Suite", () => {
  const options = {
    includeParameters: true,
    includeVariables: true,
    includeImports: true,
  };

  test("assigns stable colors to parameters and variables in a function", () => {
    const source = `function greet(firstName: string, lastName: string) {
	const message = firstName + lastName;
	return message;
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "firstName"),
      [0, 0],
    );
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "lastName"),
      [1, 1],
    );
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "message"),
      [2, 2],
    );
  });

  test("uses a new color sequence for nested function parameters", () => {
    const source = `function outer(user: string) {
	const count = user.length;
	return [user].map((user) => {
		const label = user + count;
		return label;
	});
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );
    const entries = entriesWithText(source, decorations);

    assert.deepStrictEqual(
      entries
        .filter((entry) => entry.text === "count")
        .map((entry) => entry.colorIndex),
      [1, 1],
    );
    assert.deepStrictEqual(
      entries
        .filter((entry) => entry.text === "label")
        .map((entry) => entry.colorIndex),
      [1, 1],
    );
    assert.strictEqual(
      entries.find(
        (entry) =>
          entry.text === "user" && entry.start > source.indexOf("(user)"),
      )?.colorIndex,
      0,
    );
  });

  test("does not color property names as variable usages", () => {
    const source = `function run(item: { value: number }) {
	item.value = item.value + 1;
	const value = item.value;
	return value;
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "item"),
      [0, 0, 0, 0],
    );
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "value"),
      [1, 1],
    );
  });

  test("colors import bindings and their usages", () => {
    const source = `import React, { useMemo as memo, useState } from "react";
import * as path from "node:path";

const items = memo(() => useState(path.sep), []);
console.log(React, items);`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "React"),
      [0, 0],
    );
    assert.deepStrictEqual(namesWithColor(source, decorations, "memo"), [1, 1]);
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "useState"),
      [2, 2],
    );
    assert.deepStrictEqual(namesWithColor(source, decorations, "path"), [3, 3]);
  });
});

function namesWithColor(
  source: string,
  decorations: readonly RainbowDecoration[],
  name: string,
): number[] {
  return entriesWithText(source, decorations)
    .filter((entry) => entry.text === name)
    .map((entry) => entry.colorIndex);
}

function entriesWithText(
  source: string,
  decorations: readonly RainbowDecoration[],
): Array<RainbowDecoration & { text: string }> {
  return decorations.map((decoration) => ({
    ...decoration,
    text: source.slice(decoration.start, decoration.end),
  }));
}
