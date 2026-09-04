package com.dsh.flowable.api;

import java.util.Map;

/**
 * userTask 完成请求体(design 2026-09-01 §6 新契约)。
 *
 * <p>员工端在提交对话框中已完成 JSON → 流程变量的映射,引擎端直接接收 variables Map。
 */
public record CompleteTaskRequest(Map<String, Object> variables) {
}
