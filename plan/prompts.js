/* 计划拆解的 AI 提示词（「复制提示词」手动模式用）。
 * 与 Worker 的 src/wbs-ai.js 保持一致；改提示词时两处一起改。 */
(function (global) {
  "use strict";
var SYSTEM_PROMPT = "你是一名资深项目管理专家，精通 WBS（工作分解结构）、100% 原则和可交付成果导向的拆解方法。" +
  "你只输出严格的 JSON，不输出任何解释性文字、Markdown 代码围栏或多余标点。" +
  "你写的每个工作包都必须能被验收，禁止输出无法检验的虚节点。";

function buildDecomposePrompt(input) {
  const depth = Math.min(4, Math.max(2, Number(input.depth) || 3));
  const lines = [
    "请把下面这个目标拆解成 WBS（工作分解结构）。",
    "",
    "【目标】" + input.goal,
    input.startDate || input.endDate ? "【时间范围】" + (input.startDate || "不限") + " 至 " + (input.endDate || "不限") : "",
    input.team ? "【执行角色/团队】" + input.team : "",
    input.extra ? "【约束与要求】" + input.extra : "",
    "",
    "【拆解规则】",
    "1. 层级：共 " + depth + " 层。第 1 层是阶段或主要交付物（3-6 个），第 2 层是工作包，" + (depth >= 3 ? "第 3 层是可在一周内完成的具体活动。" : "不再展开第 3 层。"),
    "2. 100% 原则：同一父项下的子项之和必须完整覆盖父项范围，不重叠、不遗漏。",
    "3. 命名统一：同一层级用同一种句式，标题不超过 18 个字，不要带编号。",
    "4. 每个叶子节点必须写清 deliverable（可交付成果）和 acceptance（验收标准），验收标准要能被检验。",
    "5. 不要出现\"项目管理\"\"沟通协调\"\"其他\"这类无法验收的虚节点。",
    "6. duration 为自然日整数，叶子 2-10 天；按依赖关系给出合理工期。",
    "7. path 使用点分编号，从 1 开始，连续不跳号（如 1、1.1、1.1.1）。",
    "",
    "【输出格式】只输出一个 JSON 对象，不要任何解释文字，不要 Markdown 代码围栏：",
    "{",
    "  \"title\": \"计划标题，不超过 20 字\",",
    "  \"summary\": \"一句话说明你的拆解思路\",",
    "  \"nodes\": [",
    "    {\"path\": \"1\", \"title\": \"阶段名称\", \"deliverable\": \"\", \"acceptance\": \"\", \"owner\": \"\", \"duration\": 10},",
    "    {\"path\": \"1.1\", \"title\": \"工作包名称\", \"deliverable\": \"\", \"acceptance\": \"\", \"owner\": \"\", \"duration\": 5},",
    "    {\"path\": \"1.1.1\", \"title\": \"具体活动\", \"deliverable\": \"产出物\", \"acceptance\": \"验收口径\", \"owner\": \"角色\", \"duration\": 3}",
    "  ]",
    "}",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

function buildExpandPrompt(input) {
  return [
    "请把下面这个 WBS 工作项继续拆解为下一层子项。",
    "",
    "【所属计划】" + (input.planTitle || "未命名计划"),
    "【计划目标】" + (input.goal || "—"),
    "【当前节点】" + input.nodeTitle + (input.nodeCode ? "（编号 " + input.nodeCode + "）" : ""),
    input.nodeDeliverable ? "【该节点交付物】" + input.nodeDeliverable : "",
    "",
    "要求：",
    "1. 只输出该节点的直接子项，2-6 个，每个子项是一周内可完成的工作包或活动。",
    "2. 子项之和要完整覆盖该节点范围，不重不漏。",
    "3. 标题不超过 18 字，不重复父节点名称。",
    "4. 每个子项给出 deliverable（交付物）、acceptance（验收标准）、duration（自然日，2-10 天）。",
    "",
    "【输出格式】只输出 JSON，不要解释：",
    "{\"nodes\":[{\"title\":\"子项名称\",\"deliverable\":\"产出物\",\"acceptance\":\"验收口径\",\"duration\":3}]}",
  ].filter((l) => l !== "").join("\n");
}

  global.ZNPrompts = { SYSTEM_PROMPT: SYSTEM_PROMPT, buildDecomposePrompt: buildDecomposePrompt, buildExpandPrompt: buildExpandPrompt };
})(typeof self !== "undefined" ? self : this);
