package plugins

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DependencyGraph is the Studio-facing content topology. Edges point from a
// dependency to the record that consumes it, so following the graph forward
// answers "where will this change appear?" and following it backward answers
// "what feeds this screen?".
type DependencyGraph struct {
	Nodes []DependencyNode `json:"nodes"`
	Edges []DependencyEdge `json:"edges"`
}

type DependencyNode struct {
	ID   uuid.UUID `json:"id"`
	Type string    `json:"type"`
	Name string    `json:"name"`
}

type DependencyEdge struct {
	FromType     string    `json:"fromType"`
	FromID       uuid.UUID `json:"fromId"`
	ToType       string    `json:"toType"`
	ToID         uuid.UUID `json:"toId"`
	Relationship string    `json:"relationship"`
}

func (s *Service) DependencyGraph(ctx context.Context, visibleScreenIDs []uuid.UUID) (DependencyGraph, error) {
	graph := DependencyGraph{Nodes: []DependencyNode{}, Edges: []DependencyEdge{}}
	rows, err := s.db.Query(ctx, `
		WITH visible_screens AS (SELECT unnest($1::uuid[]) id)
		SELECT id,'data_source',name FROM data_sources WHERE deleted_at IS NULL
		UNION ALL
		SELECT a.id,CASE WHEN a.type='widget' THEN 'widget' ELSE 'asset' END,a.name
		  FROM assets a WHERE a.deleted_at IS NULL
		UNION ALL
		SELECT id,'layout',name FROM layouts WHERE deleted_at IS NULL
		UNION ALL
		SELECT id,'playlist',name FROM playlists WHERE deleted_at IS NULL
		UNION ALL
		SELECT id,'campaign',name FROM campaigns WHERE archived_at IS NULL
		UNION ALL
		SELECT id,'schedule',name FROM schedules WHERE deleted_at IS NULL
		UNION ALL
		SELECT id,'screen_group',name FROM screen_groups WHERE deleted_at IS NULL
		UNION ALL
		SELECT id,'screen',name FROM screens
		 WHERE archived_at IS NULL AND id IN(SELECT id FROM visible_screens)
		ORDER BY 2,3,1`, visibleScreenIDs)
	if err != nil {
		return DependencyGraph{}, err
	}
	for rows.Next() {
		var node DependencyNode
		if err = rows.Scan(&node.ID, &node.Type, &node.Name); err != nil {
			rows.Close()
			return DependencyGraph{}, err
		}
		graph.Nodes = append(graph.Nodes, node)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return DependencyGraph{}, err
	}
	rows.Close()
	widgetRows, err := s.db.Query(ctx, `SELECT a.id,w.provider,w.configuration,w.managed_data_source_id
		FROM widgets w JOIN assets a ON a.id=w.asset_id AND a.deleted_at IS NULL ORDER BY a.id`)
	if err != nil {
		return DependencyGraph{}, err
	}
	sources := map[uuid.UUID]bool{}
	for _, node := range graph.Nodes {
		if node.Type == "data_source" {
			sources[node.ID] = true
		}
	}
	catalog := s.catalog()
	for widgetRows.Next() {
		var widgetID uuid.UUID
		var provider string
		var configuration json.RawMessage
		var managedID *uuid.UUID
		if err = widgetRows.Scan(&widgetID, &provider, &configuration, &managedID); err != nil {
			widgetRows.Close()
			return DependencyGraph{}, err
		}
		ids := catalog.WidgetDataSourceIDs(provider, configuration)
		if managedID != nil {
			ids = append(ids, *managedID)
		}
		seen := map[uuid.UUID]bool{}
		for _, id := range ids {
			if sources[id] && !seen[id] {
				graph.Edges = append(graph.Edges, DependencyEdge{FromType: "data_source", FromID: id,
					ToType: "widget", ToID: widgetID, Relationship: "provides data to"})
				seen[id] = true
			}
		}
	}
	err = widgetRows.Err()
	widgetRows.Close()
	if err != nil {
		return DependencyGraph{}, err
	}

	edgeQueries := []string{
		`WITH visible_screens AS (SELECT unnest($1::uuid[]) id)
		 SELECT CASE WHEN a.type='widget' THEN 'widget' ELSE 'asset' END,a.id,
		        'playlist',p.id,'included in'
		   FROM playlist_items i
		   JOIN assets a ON a.id=i.asset_id AND a.deleted_at IS NULL
		   JOIN playlists p ON p.id=i.playlist_id AND p.deleted_at IS NULL
		  WHERE i.layout_id IS NULL`,
		`WITH visible_screens AS (SELECT unnest($1::uuid[]) id)
		 SELECT 'layout',l.id,'playlist',p.id,'included in'
		   FROM playlist_items i
		   JOIN layouts l ON l.id=i.layout_id AND l.deleted_at IS NULL
		   JOIN playlists p ON p.id=i.playlist_id AND p.deleted_at IS NULL`,
		`WITH visible_screens AS (SELECT unnest($1::uuid[]) id)
		 SELECT d.dependency_type,d.dependency_id,'layout',l.id,'used by'
		   FROM layout_draft_dependencies d
		   JOIN layouts l ON l.id=d.layout_id AND l.deleted_at IS NULL
		  WHERE d.dependency_type IN ('data_source','widget','asset','playlist')`,
		`SELECT 'playlist',p.id,'campaign',c.id,'used by'
		   FROM campaigns c
		   CROSS JOIN LATERAL jsonb_array_elements(c.draft->'blocks') block
		   JOIN playlists p ON p.id::text=block->>'contentId'
		  WHERE c.archived_at IS NULL AND p.deleted_at IS NULL AND block->>'contentType'='playlist'`,
		`SELECT 'layout',l.id,'campaign',c.id,'used by'
		   FROM campaigns c
		   CROSS JOIN LATERAL jsonb_array_elements(c.draft->'blocks') block
		   JOIN layouts l ON l.id::text=block->>'contentId'
		  WHERE c.archived_at IS NULL AND l.deleted_at IS NULL AND block->>'contentType'='layout'`,
		`SELECT 'campaign',s.campaign_id,'schedule',s.id,'materialized as'
		   FROM schedules s
		   JOIN campaigns c ON c.id=s.campaign_id AND c.archived_at IS NULL
		  WHERE s.deleted_at IS NULL`,
		`WITH visible_screens AS (SELECT unnest($1::uuid[]) id)
		 SELECT CASE WHEN s.layout_id IS NOT NULL THEN 'layout' ELSE 'playlist' END,
		        COALESCE(s.layout_id,s.playlist_id),'schedule',s.id,'scheduled by'
		   FROM schedules s WHERE s.deleted_at IS NULL AND s.display_action IS NULL`,
		`WITH visible_screens AS (SELECT unnest($1::uuid[]) id)
		 SELECT CASE WHEN a.layout_id IS NOT NULL THEN 'layout' ELSE 'playlist' END,
		        COALESCE(a.layout_id,a.playlist_id),'screen',a.screen_id,'assigned to'
		   FROM screen_playlist_assignments a
		   JOIN screens sc ON sc.id=a.screen_id AND sc.archived_at IS NULL
		  WHERE sc.id IN(SELECT id FROM visible_screens)`,
		`WITH visible_screens AS (SELECT unnest($1::uuid[]) id)
		 SELECT CASE WHEN a.layout_id IS NOT NULL THEN 'layout' ELSE 'playlist' END,
		        COALESCE(a.layout_id,a.playlist_id),'screen_group',a.screen_group_id,'assigned to'
		   FROM screen_group_playlist_assignments a
		   JOIN screen_groups g ON g.id=a.screen_group_id AND g.deleted_at IS NULL`,
		`WITH visible_screens AS (SELECT unnest($1::uuid[]) id)
		 SELECT 'schedule',t.schedule_id,
		        CASE WHEN t.screen_id IS NOT NULL THEN 'screen' ELSE 'screen_group' END,
		        COALESCE(t.screen_id,t.screen_group_id),'targets'
		   FROM schedule_targets t
		   JOIN schedules s ON s.id=t.schedule_id AND s.deleted_at IS NULL
		  WHERE t.screen_id IS NULL OR t.screen_id IN(SELECT id FROM visible_screens)`,
		`WITH visible_screens AS (SELECT unnest($1::uuid[]) id)
		 SELECT 'screen_group',m.screen_group_id,'screen',m.screen_id,'contains'
		   FROM screen_group_memberships m
		   JOIN screen_groups g ON g.id=m.screen_group_id AND g.deleted_at IS NULL
		   JOIN screens sc ON sc.id=m.screen_id AND sc.archived_at IS NULL
		  WHERE sc.id IN(SELECT id FROM visible_screens)`,
	}
	for _, query := range edgeQueries {
		var edgeRows pgx.Rows
		var queryErr error
		if strings.Contains(query, "$1") {
			edgeRows, queryErr = s.db.Query(ctx, query, visibleScreenIDs)
		} else {
			edgeRows, queryErr = s.db.Query(ctx, query)
		}
		if queryErr != nil {
			return DependencyGraph{}, fmt.Errorf("query dependency graph edges: %w", queryErr)
		}
		for edgeRows.Next() {
			var edge DependencyEdge
			if queryErr = edgeRows.Scan(&edge.FromType, &edge.FromID, &edge.ToType, &edge.ToID, &edge.Relationship); queryErr != nil {
				edgeRows.Close()
				return DependencyGraph{}, queryErr
			}
			graph.Edges = append(graph.Edges, edge)
		}
		queryErr = edgeRows.Err()
		edgeRows.Close()
		if queryErr != nil {
			return DependencyGraph{}, queryErr
		}
	}
	return graph, nil
}
