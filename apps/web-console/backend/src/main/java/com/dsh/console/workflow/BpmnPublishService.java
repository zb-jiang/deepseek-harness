package com.dsh.console.workflow;

import com.dsh.console.workflow.dto.PublishResult;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.client.MultipartBodyBuilder;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

/**
 * 调 Flowable REST 部署 BPMN。
 *
 * <p>Flowable REST API:
 * <pre>POST {flowable}/process-api/repository/deployments</pre>
 * Content-Type: multipart/form-data
 * 字段:
 * <ul>
 *   <li>{@code name}:部署名称(可任意)</li>
 *   <li>{@code content-type-2}:text/xml(表示 BPMN XML 资源)</li>
 *   <li>文件字段(任意 key):BPMN XML 内容</li>
 * </ul>
 *
 * <p>响应:{"id":"...", "name":"...", "deployedTime":"...", "resources":[...]}
 *
 * <p>部署成功后查 GET /process-api/repository/process-definitions?deploymentId={deploymentId}
 * 拿到 procdef ID。
 */
@Service
public class BpmnPublishService {

    private final RestClient flowableRestClient;
    private final ObjectMapper objectMapper;

    public BpmnPublishService(RestClient flowableRestClient, ObjectMapper objectMapper) {
        this.flowableRestClient = flowableRestClient;
        this.objectMapper = objectMapper;
    }

    /**
     * 部署 BPMN XML 到 Flowable 引擎。
     *
     * @param bpmnXml        BPMN XML 字符串
     * @param deploymentName 部署名称(建议用 workflow definition 名 + 版本号)
     * @return 部署结果,含 deploymentId 与 procdefId
     */
    public PublishResult publish(String bpmnXml, String deploymentName) {
        // 1) multipart 上传 BPMN XML 到 /process-api/repository/deployments
        MultipartBodyBuilder builder = new MultipartBodyBuilder();
        builder.part("name", deploymentName);
        builder.part("content-type-2", "text/xml");
        // BPMN XML 文件字段(任意 key,Flowable 根据 content-type 识别)
        builder.part("bpmn-file", new ByteArrayResource(bpmnXml.getBytes(StandardCharsets.UTF_8)) {
            @Override
            public String getFilename() {
                return deploymentName.replaceAll("[^a-zA-Z0-9-_]", "_") + ".bpmn20.xml";
            }
        });

        JsonNode deployResp = flowableRestClient.post()
            .uri("/process-api/repository/deployments")
            .body(builder.build())
            .retrieve()
            .body(JsonNode.class);
        if (deployResp == null || deployResp.path("id").asText().isEmpty()) {
            throw new IllegalStateException("Flowable 部署响应缺 id 字段: " + deployResp);
        }
        String deploymentId = deployResp.path("id").asText();

        // 2) 查 deployment 下的 procdef
        JsonNode procdefs = flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/process-api/repository/process-definitions")
                .queryParam("deploymentId", deploymentId)
                .build())
            .retrieve()
            .body(JsonNode.class);
        JsonNode data = procdefs == null ? null : procdefs.path("data");
        if (data == null || data.size() == 0) {
            throw new IllegalStateException("部署成功但 Flowable 未识别出 process-definition: deploymentId=" + deploymentId);
        }
        String procdefId = data.get(0).path("id").asText();
        if (procdefId.isEmpty()) {
            throw new IllegalStateException("procdef 响应缺 id 字段: " + data.get(0));
        }

        return new PublishResult(null, deploymentId, procdefId);
    }
}
