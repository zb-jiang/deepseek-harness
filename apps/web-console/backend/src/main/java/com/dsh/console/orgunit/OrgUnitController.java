package com.dsh.console.orgunit;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.orgunit.dto.OrgUnitDto;
import com.dsh.console.orgunit.dto.OrgUnitTreeNode;
import com.dsh.console.orgunit.dto.SaveOrgUnitRequest;
import com.dsh.console.security.AuthContext;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 组织树(部门)治理 REST 端点。
 *
 * <p>组织树是全局治理数据,仅 {@code system_admin} 可访问(设计 2026-09-19 §6.1)。
 * 应用管理员为流程配置读取部门下拉时,后续按需开只读端点。
 */
@RestController
@RequestMapping("/api/org-units")
@PreAuthorize("hasRole('SYSTEM_ADMIN')")
public class OrgUnitController {

    private final OrgUnitService orgUnitService;

    public OrgUnitController(OrgUnitService orgUnitService) {
        this.orgUnitService = orgUnitService;
    }

    /**
     * 部门树(嵌套 JSON,含负责人显示名)。
     */
    @GetMapping
    public ApiResponse<List<OrgUnitTreeNode>> tree() {
        return ApiResponse.ok(orgUnitService.tree());
    }

    /**
     * 新建部门。
     */
    @PostMapping
    public ApiResponse<OrgUnitDto> create(@Valid @RequestBody SaveOrgUnitRequest body,
                                           @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(orgUnitService.create(body, auth.platformUserId()));
    }

    /**
     * 更新部门(全量覆盖:名称/父部门/负责人/排序)。
     */
    @PatchMapping("/{orgUnitId}")
    public ApiResponse<OrgUnitDto> update(@PathVariable UUID orgUnitId,
                                          @Valid @RequestBody SaveOrgUnitRequest body,
                                          @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(orgUnitService.update(orgUnitId, body, auth.platformUserId()));
    }

    /**
     * 删除部门(守卫:无子部门、无成员)。
     */
    @DeleteMapping("/{orgUnitId}")
    public ApiResponse<Void> delete(@PathVariable UUID orgUnitId,
                                    @AuthenticationPrincipal AuthContext auth) {
        orgUnitService.delete(orgUnitId, auth.platformUserId());
        return ApiResponse.ok(null);
    }
}
