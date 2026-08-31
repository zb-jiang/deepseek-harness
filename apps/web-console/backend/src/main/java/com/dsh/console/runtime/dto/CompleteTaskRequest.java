package com.dsh.console.runtime.dto;

import java.util.Map;

/**
 * 完成任务请求。
 *
 * <p>V1 Web Console 后端提供此端点仅用于端到端联调:代办真正的完成入口在 DSH
 * enterprise profile task-api 层(spec §3 + §8.8),那里做输出校验(ajv)+ 缺项回喂。
 * Web Console 这里只是简化的人工干预通道,不做输出校验,直接转发到 Flowable。
 *
 * @param variables 完成时写入的变量(可空,如 output_data 等)
 */
public record CompleteTaskRequest(
    Map<String, Object> variables
) {
}
