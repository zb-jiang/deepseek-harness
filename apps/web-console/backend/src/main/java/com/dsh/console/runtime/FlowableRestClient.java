package com.dsh.console.runtime;

import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * Flowable 引擎 REST API 薄封装。
 *
 * <p>Web Console 后端通过此客户端调用 Flowable 引擎(V1 用 basic auth,见
 * {@link com.dsh.console.config.RestClientConfig})。所有路径前缀 {@code /process-api}
 * 对应 Flowable 7 OSS REST。
 *
 * <p>404 由本客户端抛 {@link NotFoundException},由
 * {@link com.dsh.console.common.GlobalExceptionHandler} 转 404;5xx 仍抛
 * {@code RestClientException} 转 502。
 *
 * <p>Flowable REST 变量格式:{@code [{"name":"k","value":"v"},...]},不是普通 JSON Map。
 * {@link #toRestVariables(Map)} 做转换。
 */
@Component("flowableServiceClient")
public class FlowableRestClient {

    private final RestClient flowableRestClient;

    public FlowableRestClient(RestClient flowableRestClient) {
        this.flowableRestClient = flowableRestClient;
    }

    /**
     * 启动流程实例。
     *
     * @param procdefId      Flowable procdef id
     * @param businessKey    业务键(可空)
     * @param name           实例名(可空)
     * @param variables      变量(可空,含 dsh_applicant_user_id 等)
     * @return Flowable 返回的实例 JSON(含 id / businessKey / processDefinitionId / startUserId / startTime / suspended)
     */
    public JsonNode startProcessInstance(String procdefId, String businessKey, String name,
                                        Map<String, Object> variables) {
        java.util.Map<String, Object> body = new java.util.HashMap<>();
        body.put("processDefinitionId", procdefId);
        if (businessKey != null && !businessKey.isBlank()) {
            body.put("businessKey", businessKey);
        }
        if (name != null && !name.isBlank()) {
            body.put("name", name);
        }
        body.put("variables", toRestVariables(variables));

        return flowableRestClient.post()
            .uri("/process-api/runtime/process-instances")
            .body(body)
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 查运行中实例详情。不存在抛 {@link NotFoundException}。
     */
    public JsonNode getRuntimeProcessInstance(String instanceId) {
        return flowableRestClient.get()
            .uri("/process-api/runtime/process-instances/{id}", instanceId)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("流程实例不存在(runtime): " + instanceId); })
            .body(JsonNode.class);
    }

    /**
     * 列运行中实例(可按 procdefId 过滤)。
     *
     * <p>Flowable 返回 {@code {"data":[...],"total":N,...}}。
     */
    public JsonNode listRuntimeProcessInstances(String procdefId, Integer start, Integer size) {
        return flowableRestClient.get()
            .uri(uriBuilder -> {
                uriBuilder.path("/process-api/runtime/process-instances");
                if (procdefId != null && !procdefId.isBlank()) {
                    uriBuilder.queryParam("processDefinitionId", procdefId);
                }
                if (start != null) {
                    uriBuilder.queryParam("start", start);
                }
                if (size != null) {
                    uriBuilder.queryParam("size", size);
                }
                return uriBuilder.build();
            })
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 终止实例(DELETE runtime instance + deleteReason)。
     *
     * <p>Flowable 7 OSS {@code DELETE /process-api/runtime/process-instances/{id}} 不直接支持
     * body,deleteReason 通过 query param 传。{@code cascade} 默认 false(只删实例,不删 historic);
     * V1 保留 historic 数据用于审计。
     *
     * @throws NotFoundException 实例不存在
     */
    public void deleteProcessInstance(String instanceId, String deleteReason) {
        flowableRestClient.delete()
            .uri(uriBuilder -> {
                uriBuilder.path("/process-api/runtime/process-instances/{id}");
                if (deleteReason != null && !deleteReason.isBlank()) {
                    uriBuilder.queryParam("deleteReason", deleteReason);
                }
                return uriBuilder.build(instanceId);
            })
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("流程实例不存在(已结束或不存在): " + instanceId); })
            .toBodilessEntity();
    }

    /**
     * 列实例当前任务(runtime tasks)。
     *
     * <p>Flowable 返回 {@code {"data":[...],"total":N,...}}。
     */
    public JsonNode listTasksByProcessInstance(String instanceId) {
        return flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/process-api/runtime/tasks")
                .queryParam("processInstanceId", instanceId)
                .build())
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 完成任务。
     *
     * <p>Flowable 7 REST 完成 task 用 {@code POST /process-api/runtime/tasks/{taskId}},
     * body {@code {"action":"complete","variables":[{"name":"k","value":"v"}]}}。
     *
     * @throws NotFoundException 任务不存在
     */
    public void completeTask(String taskId, Map<String, Object> variables) {
        java.util.Map<String, Object> body = new java.util.HashMap<>();
        body.put("action", "complete");
        body.put("variables", toRestVariables(variables));

        flowableRestClient.post()
            .uri("/process-api/runtime/tasks/{taskId}", taskId)
            .body(body)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("任务不存在: " + taskId); })
            .toBodilessEntity();
    }

    /**
     * 取流程定义已部署的 BPMN XML(启动校验按部署版本而非草稿)。
     *
     * <p>用 Flowable 单步端点 {@code GET /repository/process-definitions/{id}/resourcedata},
     * 引擎内部按 deploymentId + resourceName 定位资源,直接返回 XML 内容。
     * 注意 process-definition 详情响应里资源名字段是 {@code resource},不是 resourceName。
     *
     * @throws NotFoundException 流程定义不存在
     */
    public String getProcessDefinitionBpmnXml(String procdefId) {
        return flowableRestClient.get()
            .uri("/process-api/repository/process-definitions/{id}/resourcedata", procdefId)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("流程定义不存在: " + procdefId); })
            .body(String.class);
    }

    /**
     * Map 变量转 Flowable REST 变量数组格式。
     *
     * <p>Flowable REST 变量是 {@code [{"name":"k","value":"v"}]} 数组,不是 Map。
     * 值为 null 时跳过(Flowable 不接受 null value)。
     */
    static List<Map<String, Object>> toRestVariables(Map<String, Object> variables) {
        List<Map<String, Object>> result = new ArrayList<>();
        if (variables == null || variables.isEmpty()) {
            return result;
        }
        variables.forEach((k, v) -> {
            if (v == null) {
                return;
            }
            result.add(Map.of("name", k, "value", v));
        });
        return result;
    }
}
