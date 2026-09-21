package com.dsh.flowable.api;

import java.time.Instant;
import java.util.Date;
import java.util.List;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.runtime.ProcessInstance;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * DSH 运行中实例查询 REST 端点。
 *
 * <p>Flowable 官方 runtime REST({@code /process-api/runtime/process-instances})的响应
 * representation 不带 processDefinitionKey 等定义字段,且 Web Console 需要"按流程定义 key
 * 跨部署版本收集"的查询口径——流程重新发布后运行中实例可能仍挂在旧版本 procdef 上,
 * 按当前发布版本 procdefId 查会漏掉它们。本端点用 {@code ProcessInstanceQuery.processDefinitionKey}
 * 过滤并返回 key/名称/版本(runtime {@code ProcessInstance} 接口自带,无需补查)。
 *
 * <p><b>鉴权</b>:与 {@link DshHistoryController} 同一模式,任何已认证用户可查
 * (引擎侧不做应用归属判定,归属过滤在 Web Console 后端完成)。
 *
 * <p><b>分页</b>:page/size 简单分页(默认 size=50,最大 200),返回 plain list,
 * 与 {@link DshHistoryController} 端点约定一致。
 */
@RestController
@RequestMapping("/dsh/runtime")
public class DshRuntimeController {

    /** 单页最大返回条数,防止前端误传大 size 拖垮引擎。 */
    private static final int MAX_PAGE_SIZE = 200;
    private static final int DEFAULT_PAGE_SIZE = 50;

    private final RuntimeService runtimeService;

    public DshRuntimeController(RuntimeService runtimeService) {
        this.runtimeService = runtimeService;
    }

    /**
     * 查运行中实例,可按流程定义 key 过滤(跨部署版本收集)。
     *
     * <p>按发起时间倒序。不传 key 时返回全部运行中实例。
     *
     * @param processDefinitionKey 可选;按流程定义 key 过滤(同流程各部署版本的运行中实例一并返回)
     * @param page                 页码(0-based),默认 0
     * @param size                 单页条数,默认 50,上限 200
     */
    @GetMapping("/process-instances")
    public List<RuntimeProcessInstanceDto> getRuntimeProcessInstances(
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey,
        @RequestParam(name = "page", defaultValue = "0") int page,
        @RequestParam(name = "size", defaultValue = "50") int size
    ) {
        int safeSize = clampSize(size);
        int firstResult = Math.max(0, page) * safeSize;

        var query = runtimeService.createProcessInstanceQuery()
            .orderByStartTime().desc();
        if (processDefinitionKey != null && !processDefinitionKey.isBlank()) {
            query.processDefinitionKey(processDefinitionKey);
        }

        List<ProcessInstance> instances = query.listPage(firstResult, safeSize);
        return instances.stream().map(this::toDto).toList();
    }

    private RuntimeProcessInstanceDto toDto(ProcessInstance instance) {
        return new RuntimeProcessInstanceDto(
            instance.getId(),
            instance.getProcessDefinitionId(),
            instance.getProcessDefinitionKey(),
            instance.getProcessDefinitionName(),
            instance.getProcessDefinitionVersion(),
            instance.getBusinessKey(),
            instance.getName(),
            instance.getStartUserId(),
            toIso(instance.getStartTime()),
            instance.isSuspended()
        );
    }

    private String toIso(Date date) {
        return date == null ? null : Instant.ofEpochMilli(date.getTime()).toString();
    }

    private static int clampSize(int size) {
        if (size <= 0) {
            return DEFAULT_PAGE_SIZE;
        }
        return Math.min(size, MAX_PAGE_SIZE);
    }
}
