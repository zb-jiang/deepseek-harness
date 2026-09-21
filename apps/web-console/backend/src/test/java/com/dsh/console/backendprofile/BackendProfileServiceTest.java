package com.dsh.console.backendprofile;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.backendprofile.dto.SkillRequirementDto;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * skill 归属聚合测试(design 2026-09-14 §5.4):按 URL 收已发布快照中 DSH
 * backend task 节点的 skillRefs 并去重(带应用绑定的 SkillHub namespace);
 * URL 不匹配/无快照/坏 XML/应用未绑 namespace 的边界。
 */
class BackendProfileServiceTest {

    private static final String URL = "http://backend-1:3190";
    private static final String NS = "ns-a";

    private BackendProfileService service;
    private WorkflowDefinitionJdbcRepository workflowRepository;
    private ApplicationJdbcRepository appRepository;

    @BeforeEach
    void setUp() {
        BackendProfileJdbcRepository profileRepository = mock(BackendProfileJdbcRepository.class);
        workflowRepository = mock(WorkflowDefinitionJdbcRepository.class);
        appRepository = mock(ApplicationJdbcRepository.class);
        service = new BackendProfileService(profileRepository, workflowRepository, appRepository);
    }

    @Test
    void aggregatesAndDeduplicatesSkillRefsAcrossPublishedSnapshots() {
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(NS)));
        when(workflowRepository.listPublishedWithXml()).thenReturn(List.of(
            publishedWorkflow(bpmnWithBackendTask("skill-a", "skill-b")),
            publishedWorkflow(bpmnWithBackendTask("skill-a", "skill-c"))));
        assertThat(service.aggregateSkillRefs(URL)).containsExactly(
            new SkillRequirementDto(NS, "skill-a"),
            new SkillRequirementDto(NS, "skill-b"),
            new SkillRequirementDto(NS, "skill-c"));
    }

    @Test
    void skipsBackendTasksPointingToOtherUrlsAndPlainServiceTasks() {
        String otherUrlTask = backendTask("http://other:3190", "skill-x");
        String plainTask = """
              <serviceTask id="plain" name="普通自动节点">
                <extensionElements>
                  <dsh:skillRef>skill-y</dsh:skillRef>
                </extensionElements>
              </serviceTask>""";
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(NS)));
        when(workflowRepository.listPublishedWithXml())
            .thenReturn(List.of(publishedWorkflow(bpmnBody(backendTask(URL, "skill-a") + otherUrlTask + plainTask))));
        assertThat(service.aggregateSkillRefs(URL)).containsExactly(new SkillRequirementDto(NS, "skill-a"));
    }

    @Test
    void aggregatesProfileListRowsOfMultiInstanceBackendTasks() {
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(NS)));
        String multiInstanceTask = """
              <serviceTask id="backend-mi" name="多 AI 会诊">
                <extensionElements>
                  <dsh:backendTask>
                    <dsh:backendProfile url="%s"/>
                    <dsh:backendProfile url="http://other:3190"/>
                  </dsh:backendTask>
                  <dsh:skillRef>skill-a</dsh:skillRef>
                </extensionElements>
              </serviceTask>""".formatted(URL);
        when(workflowRepository.listPublishedWithXml())
            .thenReturn(List.of(publishedWorkflow(bpmnBody(multiInstanceTask))));
        // 多实例逐行展开:同一节点的 skillRefs 归属到列表里每个被绑定的 profile
        assertThat(service.aggregateSkillRefs(URL))
            .containsExactly(new SkillRequirementDto(NS, "skill-a"));
        assertThat(service.aggregateSkillRefs("http://other:3190"))
            .containsExactly(new SkillRequirementDto(NS, "skill-a"));
        assertThat(service.aggregateSkillRefs("http://unbound:3190")).isEmpty();
    }

    @Test
    void skipsEntriesWhoseAppHasNoSkillhubNamespace() {
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(null)));
        when(workflowRepository.listPublishedWithXml())
            .thenReturn(List.of(publishedWorkflow(bpmnWithBackendTask("skill-a"))));
        assertThat(service.aggregateSkillRefs(URL)).isEmpty();
    }

    @Test
    void returnsEmptyWhenNoPublishedSnapshotsOrNoSkillRefs() {
        when(workflowRepository.listPublishedWithXml()).thenReturn(List.of());
        assertThat(service.aggregateSkillRefs(URL)).isEmpty();

        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(NS)));
        when(workflowRepository.listPublishedWithXml())
            .thenReturn(List.of(publishedWorkflow(bpmnBody(backendTask(URL)))));
        assertThat(service.aggregateSkillRefs(URL)).isEmpty();
    }

    @Test
    void skipsUnparsableSnapshotInsteadOfFailingTheWholeAggregation() {
        WorkflowDefinitionDto broken = publishedWorkflow("not xml at all <");
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(NS)));
        when(workflowRepository.listPublishedWithXml()).thenReturn(List.of(
            broken, publishedWorkflow(bpmnWithBackendTask("skill-a"))));
        assertThat(service.aggregateSkillRefs(URL)).containsExactly(new SkillRequirementDto(NS, "skill-a"));
    }

    /** 构造一个指向 URL、引用若干 skill 的 DSH backend task 的完整 BPMN。 */
    private String bpmnWithBackendTask(String... skillRefs) {
        return bpmnBody(backendTask(URL, skillRefs));
    }

    /** DSH backend task 节点 XML;skillRefs 为空时不带 skillRef 子元素。 */
    private String backendTask(String url, String... skillRefs) {
        StringBuilder refs = new StringBuilder();
        for (String skill : skillRefs) {
            refs.append("      <dsh:skillRef>").append(skill).append("</dsh:skillRef>\n");
        }
        return """
              <serviceTask id="backend" name="后台节点">
                <extensionElements>
                  <dsh:backendTask backendProfileUrl="%s"/>
            %s    </extensionElements>
              </serviceTask>""".formatted(url, refs);
    }

    private String bpmnBody(String serviceTasksXml) {
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="backend_aggregation_test" isExecutable="true">
            %s
              </process>
            </definitions>""".formatted(serviceTasksXml);
    }

    private WorkflowDefinitionDto publishedWorkflow(String bpmnXml) {
        return new WorkflowDefinitionDto(
            UUID.randomUUID(), UUID.randomUUID(), "测试流程", null, "published",
            null, "dep-1", "proc-1", bpmnXml, "backend_aggregation_test", null, null, null, null);
    }

    private ApplicationDto app(String skillhubNamespace) {
        return new ApplicationDto(UUID.randomUUID(), "测试应用", null, null,
            skillhubNamespace, "active", List.of(), null, null, null, null);
    }
}
