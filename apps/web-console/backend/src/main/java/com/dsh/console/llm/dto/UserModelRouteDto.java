package com.dsh.console.llm.dto;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * 用户模型额度路由视图。
 * 业务含义:对应 llm_user_model_routes 及其顺位项;items 按 priority 升序,运行时依次尝试扣减。
 */
public record UserModelRouteDto(
    UUID id,
    UUID userId,
    String userDisplayName,
    UUID modelId,
    String modelDisplayName,
    String exhaustAction,
    boolean enabled,
    List<RouteItemDto> items,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt
) {

    /** 返回替换顺位项后的新实例,供 Repository 组装完整视图。 */
    public UserModelRouteDto withItems(List<RouteItemDto> items) {
        return new UserModelRouteDto(id, userId, userDisplayName, modelId, modelDisplayName,
            exhaustAction, enabled, items, createdAt, updatedAt);
    }

    /**
     * 路由顺位项。
     * 业务含义:一个有顺序的额度池;sourceName 为联立的用户显示名或部门名,仅供展示。
     */
    public record RouteItemDto(
        UUID id,
        int priority,
        String sourceType,
        UUID sourceId,
        String sourceName,
        boolean enabled
    ) {}
}
