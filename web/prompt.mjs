export async function loadExportPrompt() {
  const response = await fetch(
    new URL("../protocol/export-prompt-zh.txt", import.meta.url),
  );
  if (!response.ok) throw new Error("导出提示词加载失败");
  return (await response.text()).trimEnd();
}
