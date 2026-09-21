package com.dsh.console.backendprofile;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.backendprofile.dto.BackendProfileDto;
import com.dsh.console.backendprofile.dto.BackendProfileRegisterRequest;
import com.dsh.console.backendprofile.dto.SkillRequirementDto;
import com.dsh.console.workflow.BpmnContextParser;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * DSH backend profile 注册表业务(design 2026-09-14 §5)。
 *
 * <p>三个职责:实例自注册/心跳(upsert 按 url)、活跃实例列表(设计器下拉)、
 * skill 归属聚合(哪些已发布 DSH backend task 指向该 URL,聚合其 skillRefs
 * 去重,供 backend profile 周期同步预装)。归属聚合只认发布版 BPMN XML
 * 快照,不解析草稿;条目带应用绑定的 SkillHub namespace(backend profile
 * 按命名空间拉清单下载,裸名不够)。
 */
@Service
public class BackendProfileService {

    private static final Logger log = LoggerFactory.getLogger(BackendProfileService.class);

    private final BackendProfileJdbcRepository profileRepository;
    private final WorkflowDefinitionJdbcRepository workflowRepository;
    private final ApplicationJdbcRepository appRepository;

    /**
     * skill 归属聚合缓存:全部已发布流程解析出的 backend task 引用(profile url +
     * namespace + skillRefs),按 {@code workflow_definitions} 的 max(updated_at)
     * 版本戳整体失效。backend profile 心跳高频调用,版本戳不变时直接命中,
     * 不重拉发布 XML 大字段、不重做 DOM 解析。
     *
     * <p>{@code aggregatedStamp} 初始 null(必 miss,首次必重建);空库的版本戳占位
     * 是 {@code MIN},不能作为初始值——否则首次调用会误命中初始空缓存。
     */
    private java.time.OffsetDateTime aggregatedStamp;
    private List<ParsedBackendTaskRef> aggregatedRefs = List.of();

    /** 单个已发布流程快照解析出的 backend task 引用(namespace 为空的任务不入列)。 */
    private record ParsedBackendTaskRef(String namespace, String profileUrl, List<String> skillRefs) {
    }

    public BackendProfileService(BackendProfileJdbcRepository profileRepository,
                                  WorkflowDefinitionJdbcRepository workflowRepository,
                                  ApplicationJdbcRepository appRepository) {
        this.profileRepository = profileRepository;
        this.workflowRepository = workflowRepository;
        this.appRepository = appRepository;
    }

    /**
     * 实例自注册/心跳:按 url upsert,刷新 last_heartbeat_at。
     */
    public void register(BackendProfileRegisterRequest request) {
        profileRepository.upsert(request.url(), request.name(), request.llmLabel(), request.workspaceLabel());
    }

    /**
     * 活跃实例列表(心跳 5 分钟内),设计器 backend task 属性面板下拉数据源。
     */
    public List<BackendProfileDto> listActive() {
        return profileRepository.listActive();
    }

    /**
     * skill 归属聚合:全部已发布流程快照中,指向 {@code url} 的 DSH backend task
     * 节点引用的 skillRefs 去重清单(带应用绑定的 SkillHub namespace)。
     *
     * <p>解析结果按版本戳缓存共享(多 profile 心跳只解析一次);单份快照解析失败
     * 跳过并记 warn——发布校验已保证入库 XML 可解析,此处防御外来的不可解析数据
     * 拖垮整个聚合端点。应用未绑定 namespace 的条目跳过(skill 无从下载安装)。
     */
    public List<SkillRequirementDto> aggregateSkillRefs(String url) {
        Set<SkillRequirementDto> result = new LinkedHashSet<>();
        for (ParsedBackendTaskRef ref : currentAggregation()) {
            if (!url.equals(ref.profileUrl())) {
                continue;
            }
            for (String skill : ref.skillRefs()) {
                result.add(new SkillRequirementDto(ref.namespace(), skill));
            }
        }
        return List.copyOf(result);
    }

    /**
     * 取当前聚合结果,版本戳不变时命中缓存。
     *
     * <p>重建在锁内做(心跳频率低,分钟级,简单互斥足够);无 published 行的空戳以
     * epoch 前({@code MIN})占位,同样参与命中——空结果不反复查库。
     */
    private synchronized List<ParsedBackendTaskRef> currentAggregation() {
        java.time.OffsetDateTime stamp = workflowRepository.maxPublishedUpdatedAt()
            .orElse(java.time.OffsetDateTime.MIN);
        if (stamp.equals(aggregatedStamp)) {
            return aggregatedRefs;
        }
        List<ParsedBackendTaskRef> refs = new java.util.ArrayList<>();
        Map<java.util.UUID, String> namespaceByApp = new HashMap<>();
        for (WorkflowDefinitionDto wf : workflowRepository.listPublishedWithXml()) {
            try {
                var doc = BpmnContextParser.parseXml(wf.publishedBpmnXml());
                String namespace = namespaceByApp.computeIfAbsent(wf.appId(), appId ->
                    appRepository.findById(appId).map(ApplicationDto::skillhubNamespace).orElse(null));
                if (namespace == null || namespace.isBlank()) {
                    continue;
                }
                for (BpmnContextParser.BackendTaskInfo info : BpmnContextParser.parseBackendTasks(doc)) {
                    refs.add(new ParsedBackendTaskRef(namespace,
                        info.backendProfileUrl(), info.skillRefs()));
                }
            } catch (Exception e) {
                log.warn("skip unparsable published bpmn snapshot (workflow {}): {}",
                    wf.id(), e.getMessage());
            }
        }
        aggregatedStamp = stamp;
        aggregatedRefs = List.copyOf(refs);
        return aggregatedRefs;
    }
}
