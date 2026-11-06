import test from "node:test";
import assert from "node:assert/strict";
import { jsonSyntaxIssue } from "../web/json-errors.mjs";
import { parseMgp, MgpError } from "../web/mgp.mjs";
import { parseBackup } from "../web/workspace.mjs";

// § marks the expected caret position, including end-of-input positions.
for (const [name, marked, hint] of [
  ["missing value", '{\n "x": §}', /需要.*JSON.*值/],
  ["quoted field", "{§'x': 1}", /字段名.*双引号/],
  ["missing colon", '{"x" §1}', /英文冒号/],
  ["object comma", '{"x":1 §"y":2}', /英文逗号/],
  ["array comma", "[1 §2]", /英文逗号/],
  ["object trailing comma", '{"x":1,§}', /多余的逗号/],
  ["array trailing comma", "[1,§]", /多余的逗号/],
  ["incomplete object", '{"x":1§', /右花括号/],
  ["incomplete array", "[1§", /右方括号/],
  ["incomplete string", '{"x":"未结束§', /结束.*双引号/],
  ["literal newline", '{"x":"line§\n"}', /不能直接换行/],
  ["bad escape", '{"x":"bad\\§q"}', /转义不正确/],
  ["bad Unicode", '{"x":"\\u12§G4"}', /Unicode 转义/],
  ["leading zero", '{"x":0§1}', /前导 0/],
  ["decimal", '{"x":2.§}', /小数点后面/],
  ["exponent", '{"x":1e+§}', /指数部分/],
  ["negative", '{"x":-§}', /负号后面/],
  ["literal spelling", '{"x":tru§X}', /拼写/],
  ["single-quoted value", "{\"x\":§'value'}", /不能使用单引号/],
  ["Markdown fence", "§```json\n{}\n```", /代码围栏/],
  ["extra document", "{} §{}", /多余内容/],
  ["Chinese punctuation", '{"x":1§，"y":2}', /英文逗号/],
  ["CRLF and Unicode", '{\r\n "x":"😀中文", "y": §}', /JSON.*值/],
]) {
  test("Chinese JSON guidance and exact caret: " + name, () => {
    const offset = marked.indexOf("§"),
      text = marked.replace("§", ""),
      preceding = text.slice(0, offset).split("\n");
    let native;
    try {
      JSON.parse(text);
    } catch (error) {
      native = error;
    }
    assert.ok(native instanceof SyntaxError);
    const issue = jsonSyntaxIssue(native, text);
    assert.equal(issue.line, preceding.length);
    assert.equal(issue.column, preceding.at(-1).length + 1);
    assert.match(issue.message, hint);
    assert.equal(issue.detail, native.message);
    // A browser without location-bearing English errors must report the same caret.
    const other = jsonSyntaxIssue(new Error("JSON Parse error"), text);
    assert.deepEqual(
      [other.line, other.column, other.message],
      [issue.line, issue.column, issue.message],
    );
  });
}
test("JSONL diagnostics retain original blank lines, BOM and record columns", () => {
  const header = JSON.stringify({
    kind: "header",
    protocol: "mgp/1.1",
    source: { id: "source" },
  });
  const text = "\uFEFF\n" + header + '\n\n\n {"kind":"node","id": }';
  assert.throws(
    () => parseMgp(text),
    (error) => {
      const issue = error.issues[0];
      assert.equal(issue.line, 5);
      assert.equal(issue.column, text.split("\n").at(-1).indexOf("}") + 1);
      assert.match(issue.message, /JSON.*值/);
      return true;
    },
  );
});
test("a multiline JSONL header reports a useful error instead of a TypeError", () => {
  const text = JSON.stringify(
    { kind: "header", protocol: "mgp/1.1", source: { id: "source" } },
    null,
    2,
  );
  assert.throws(
    () => parseMgp(text),
    (error) =>
      error instanceof MgpError &&
      error.issues[0].line === 1 &&
      error.issues[0].column === 2 &&
      /完整放在一行/.test(error.message),
  );
});
test("backup syntax errors also preserve Chinese guidance and exact location", () => {
  assert.throws(
    () => parseBackup('{\n "graph": }'),
    (error) => {
      assert.equal(error.issues[0].line, 2);
      assert.equal(error.issues[0].column, 11);
      assert.match(error.message, /JSON.*值/);
      assert.ok(error.issues[0].detail);
      return true;
    },
  );
});
test("deep malformed input cannot overflow the diagnostic scanner", () => {
  const issue = jsonSyntaxIssue(new Error("parse failed"), "[".repeat(10000));
  assert.match(issue.message, /嵌套层数/);
  assert.equal(issue.line, 1);
  assert.ok(issue.column < 200);
});
