// Runs only after JSON.parse rejects; acceptance still belongs to the native parser.
export function jsonSyntaxIssue(error, text, lineOffset = 0) {
  let pos = 0,
    problem;
  const fail = (message) => {
    throw { message, offset: pos };
  };
  const space = () => {
    while (/[ \t\r\n]/.test(text[pos] || "x")) pos++;
  };
  const digit = () => /[0-9]/.test(text[pos] || "x");
  const quoteHint =
    '字符串和字段名需要使用英文双引号（"），不能使用单引号或中文引号。';
  function string() {
    pos++;
    while (pos < text.length) {
      const char = text[pos];
      if (char === '"') {
        pos++;
        return;
      }
      if (char.charCodeAt(0) < 32)
        fail("字符串不能直接换行或包含控制字符，请使用 \\n、\\t 等转义。");
      if (char === "\\") {
        pos++;
        if (pos === text.length)
          fail("字符串中的转义尚未写完整，请补全后重试。");
        if (text[pos] === "u") {
          for (let i = 0; i < 4; i++) {
            pos++;
            if (!/[0-9a-f]/i.test(text[pos] || "x"))
              fail("\\u 后面需要四个十六进制字符，请检查 Unicode 转义。");
          }
        } else if (!'"\\/bfnrt'.includes(text[pos]))
          fail("反斜杠后的转义不正确，请检查字符串中的反斜杠写法。");
      }
      pos++;
    }
    fail('字符串缺少结束的英文双引号（"），请补全后重试。');
  }
  function value(depth = 0) {
    space();
    if (depth > 128) fail("JSON 嵌套层数过多，请减少嵌套后重试。");
    const char = text[pos];
    if (char === '"') return string();
    if (char === "{") {
      pos++;
      space();
      if (text[pos] === "}") {
        pos++;
        return;
      }
      while (pos < text.length) {
        if (text[pos] !== '"')
          fail('对象中的字段名需要使用英文双引号，例如 "protocol"。');
        string();
        space();
        if (text[pos] !== ":")
          fail("字段名后面需要英文冒号（:），请检查是否缺少或使用了中文标点。");
        pos++;
        value(depth + 1);
        space();
        if (text[pos] === "}") {
          pos++;
          return;
        }
        if (pos === text.length) fail("对象尚未结束，请补上右花括号（}）。");
        if (text[pos] !== ",")
          fail("对象的两项之间需要英文逗号（,），请检查分隔符。");
        pos++;
        space();
        if (text[pos] === "}")
          fail("最后一项后面不能有逗号，请删除右括号前多余的逗号。");
      }
      fail("对象内容尚未写完整，请补全字段和右花括号（}）。");
    }
    if (char === "[") {
      pos++;
      space();
      if (text[pos] === "]") {
        pos++;
        return;
      }
      while (pos < text.length) {
        value(depth + 1);
        space();
        if (text[pos] === "]") {
          pos++;
          return;
        }
        if (pos === text.length) fail("数组尚未结束，请补上右方括号（]）。");
        if (text[pos] !== ",")
          fail("数组的两项之间需要英文逗号（,），请检查分隔符。");
        pos++;
        space();
        if (text[pos] === "]")
          fail("最后一项后面不能有逗号，请删除右括号前多余的逗号。");
      }
      fail("数组内容尚未写完整，请补全内容和右方括号（]）。");
    }
    if (char === "-" || digit()) {
      if (char === "-") pos++;
      if (!digit()) fail("数字格式不完整，负号后面需要数字。");
      if (text[pos] === "0") {
        pos++;
        if (digit()) fail("数字不能有多余的前导 0，请检查数字写法。");
      } else while (digit()) pos++;
      if (text[pos] === ".") {
        pos++;
        if (!digit()) fail("小数点后面需要数字，请补全小数。");
        while (digit()) pos++;
      }
      if (/[eE]/.test(text[pos] || "x")) {
        pos++;
        if (/[+-]/.test(text[pos] || "x")) pos++;
        if (!digit()) fail("指数部分需要数字，请补全 e 或 E 后面的内容。");
        while (digit()) pos++;
      }
      return;
    }
    for (const word of ["true", "false", "null"])
      if (char === word[0]) {
        for (const expected of word) {
          if (text[pos] !== expected)
            fail("此处需要完整的 JSON 值 true、false 或 null，请检查拼写。");
          pos++;
        }
        return;
      }
    if (["'", "“", "”", "‘", "’"].includes(char)) fail(quoteHint);
    if (char === "`")
      fail("请只粘贴 JSON 内容，不要包含代码围栏（```）或说明文字。");
    fail(
      "此处需要合法的 JSON 值：字符串、数字、true、false、null、对象或数组。",
    );
  }
  try {
    value();
    space();
    if (pos < text.length)
      fail(
        "JSON 结束后还有多余内容，请只保留完整 JSON；JSONL 需按逐行格式导出。",
      );
  } catch (issue) {
    if (Number.isInteger(issue.offset)) problem = issue;
  }
  const nativePosition = /position (\d+)/i.exec(error?.message || ""),
    direct = /line (\d+) column (\d+)/i.exec(error?.message || ""),
    offset =
      problem?.offset ??
      Math.min(text.length, Number(nativePosition?.[1] ?? text.length)),
    lines = text.slice(0, offset).split("\n");
  return {
    path: "$",
    code: "json",
    message:
      problem?.message || "JSON 格式不正确，请检查引号、逗号和括号是否完整。",
    detail: error?.message || "JSON.parse 未能解析此内容。",
    line: lineOffset + (!problem && direct ? Number(direct[1]) : lines.length),
    column: !problem && direct ? Number(direct[2]) : lines.at(-1).length + 1,
  };
}
