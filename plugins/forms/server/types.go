// Package forms implements Form Data Sources: a Data Source provider (provider="form") whose
// records are collected through logged-in submissions, routed through a configurable approval
// workflow, and published to Widgets as named saved views. The existing data_sources row is the
// parent resource; this package owns the form-specific tables and the internally managed
// projection of approved records into the cached typed-dataset payload the Player consumes.
package server

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrNotFound is returned when a form, record, view, or grant does not exist.
	ErrNotFound = errors.New("form resource not found")
	// ErrConflict is returned when an optimistic-concurrency version check fails.
	ErrConflict = errors.New("form record was modified concurrently")
	// ErrForbidden is returned when the caller lacks the required per-form capability.
	ErrForbidden = errors.New("insufficient form access")
	// ErrValidation wraps a caller-correctable validation failure.
	ErrValidation = errors.New("form request is invalid")
	// ErrInUse is returned when a resource cannot be deleted because it is still referenced.
	ErrInUse = errors.New("form resource is in use")
)

// Capability is a per-form access grant. Global roles are unchanged; a grant additionally
// authorizes one user on one Form Data Source.
type Capability string

const (
	CapManage  Capability = "manage"
	CapSubmit  Capability = "submit"
	CapViewOwn Capability = "view_own"
	CapViewAll Capability = "view_all"
	CapReview  Capability = "review"
	CapApprove Capability = "approve"
)

var validCapabilities = map[Capability]bool{
	CapManage: true, CapSubmit: true, CapViewOwn: true,
	CapViewAll: true, CapReview: true, CapApprove: true,
}

// capabilitySatisfies reports whether a held capability satisfies a needed one. The lattice is:
// manage implies everything; approve implies review; review implies view_all (you cannot review a
// record you cannot see); view_all implies view_own.
func capabilitySatisfies(held, need Capability) bool {
	if held == need {
		return true
	}
	switch held {
	case CapManage:
		return true
	case CapApprove:
		return need == CapReview || need == CapViewAll || need == CapViewOwn
	case CapReview:
		return need == CapViewAll || need == CapViewOwn
	case CapViewAll:
		return need == CapViewOwn
	default:
		return false
	}
}

// Form field controls. section and help_text are presentation-only and produce no output field.
const (
	ControlShortText   = "short_text"
	ControlLongText    = "long_text"
	ControlNumber      = "number"
	ControlInteger     = "integer"
	ControlBoolean     = "boolean"
	ControlSelect      = "select"
	ControlMultiSelect = "multi_select"
	ControlDate        = "date"
	ControlDateTime    = "datetime"
	ControlURL         = "url"
	ControlImage       = "image"
	ControlSection     = "section"
	ControlHelpText    = "help_text"
)

// outputTypeFor maps a form control to the typed output field it exposes to Widgets, or "" for
// presentation-only controls that produce no output field.
func outputTypeFor(control string) string {
	switch control {
	case ControlShortText, ControlLongText, ControlSelect, ControlMultiSelect:
		return "text"
	case ControlNumber:
		return "number"
	case ControlInteger:
		return "integer"
	case ControlBoolean:
		return "boolean"
	case ControlDate:
		return "date"
	case ControlDateTime:
		return "datetime"
	case ControlURL:
		return "url"
	case ControlImage:
		return "asset"
	default:
		return ""
	}
}

// FormField is one field in a form definition. Keys are stable so Widgets and saved views can
// reference them across published revisions.
type FormField struct {
	Key         string         `json:"key"`
	Label       string         `json:"label"`
	Description string         `json:"description,omitempty"`
	Control     string         `json:"control"`
	Required    bool           `json:"required,omitempty"`
	Default     string         `json:"default,omitempty"`
	Options     []SelectOption `json:"options,omitempty"`
	Minimum     *float64       `json:"minimum,omitempty"`
	Maximum     *float64       `json:"maximum,omitempty"`
	MinLength   int            `json:"minLength,omitempty"`
	MaxLength   int            `json:"maxLength,omitempty"`
}

type SelectOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// FormSchema is the editable/published set of fields for a form.
type FormSchema struct {
	Title       string      `json:"title,omitempty"`
	Description string      `json:"description,omitempty"`
	Fields      []FormField `json:"fields"`
}

// Revision is one immutable published field schema.
type Revision struct {
	ID             uuid.UUID  `json:"id"`
	DataSourceID   uuid.UUID  `json:"dataSourceId"`
	RevisionNumber int        `json:"revisionNumber"`
	Title          string     `json:"title"`
	Description    string     `json:"description"`
	Schema         FormSchema `json:"schema"`
	PublishedAt    time.Time  `json:"publishedAt"`
}

// WorkflowState is one configurable workflow state. RecordCount and Removable are read-only
// decorations (populated on GetForm, ignored on write): RecordCount is the number of non-deleted
// records currently in the state, and Removable reports whether the state key may be renamed or
// removed (false once any record or saved view references it).
type WorkflowState struct {
	Key               string `json:"key"`
	Label             string `json:"label"`
	Position          int    `json:"position"`
	EligibleForOutput bool   `json:"eligibleForOutput"`
	Initial           bool   `json:"initial"`
	Terminal          bool   `json:"terminal"`
	RecordCount       int    `json:"recordCount"`
	Removable         bool   `json:"removable"`
}

// WorkflowTransition is one configurable transition between states.
type WorkflowTransition struct {
	From               string     `json:"from"`
	To                 string     `json:"to"`
	Label              string     `json:"label"`
	RequiredCapability Capability `json:"requiredCapability"`
	Position           int        `json:"position"`
}

// Workflow is the full configurable state machine for one form.
type Workflow struct {
	States      []WorkflowState      `json:"states"`
	Transitions []WorkflowTransition `json:"transitions"`
}

// Form is the top-level Form Data Source detail.
type Form struct {
	ID           uuid.UUID    `json:"id"`
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	CreatedBy    *uuid.UUID   `json:"createdBy,omitempty"`
	CreatedAt    time.Time    `json:"createdAt"`
	UpdatedAt    time.Time    `json:"updatedAt"`
	DraftSchema  FormSchema   `json:"draftSchema"`
	Published    *Revision    `json:"publishedRevision,omitempty"`
	Workflow     Workflow     `json:"workflow"`
	Views        []View       `json:"views"`
	Capabilities []Capability `json:"grantedCapabilities"`
}

// Record is a single submission.
type Record struct {
	ID            uuid.UUID      `json:"id"`
	DataSourceID  uuid.UUID      `json:"dataSourceId"`
	RevisionID    uuid.UUID      `json:"revisionId"`
	State         string         `json:"state"`
	Values        map[string]any `json:"values"`
	SubmittedBy   *uuid.UUID     `json:"submittedBy,omitempty"`
	SubmitterName string         `json:"submitterName"`
	DisplayTitle  string         `json:"displayTitle"`
	Priority      int            `json:"priority"`
	DisplayAt     *time.Time     `json:"displayAt,omitempty"`
	ExpiresAt     *time.Time     `json:"expiresAt,omitempty"`
	Eligible      bool           `json:"eligible"`
	Version       int            `json:"version"`
	CreatedAt     time.Time      `json:"createdAt"`
	UpdatedAt     time.Time      `json:"updatedAt"`
}

// RecordDetail adds history, comments, attachments, the immutable revision the record was created
// against, and server-calculated actions to a record. The action fields are decorated for a
// specific viewer so the UI never re-implements authorization: it renders exactly the transitions
// and controls the server permits.
type RecordDetail struct {
	Record
	Revision             *Revision             `json:"revision,omitempty"`
	Events               []RecordEvent         `json:"events"`
	Comments             []RecordComment       `json:"comments"`
	Attachments          []Attachment          `json:"attachments"`
	CanEdit              bool                  `json:"canEdit"`
	CanComment           bool                  `json:"canComment"`
	CanDelete            bool                  `json:"canDelete"`
	AvailableTransitions []AvailableTransition `json:"availableTransitions"`
}

// AvailableTransition is one workflow transition the viewer is permitted to perform on a record,
// resolved server-side from the configured workflow and the viewer's effective capabilities.
type AvailableTransition struct {
	To                 string     `json:"to"`
	ToLabel            string     `json:"toLabel"`
	Label              string     `json:"label"`
	RequiredCapability Capability `json:"requiredCapability"`
	// RequiresNote marks a transition that must carry a reviewer note (the default
	// changes_requested path) so the UI can require one before enabling the action.
	RequiresNote bool `json:"requiresNote"`
}

type RecordEvent struct {
	ID        uuid.UUID `json:"id"`
	EventType string    `json:"eventType"`
	FromState string    `json:"fromState,omitempty"`
	ToState   string    `json:"toState,omitempty"`
	ActorName string    `json:"actorName,omitempty"`
	Note      string    `json:"note,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type RecordComment struct {
	ID         uuid.UUID `json:"id"`
	AuthorName string    `json:"authorName"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"createdAt"`
}

type Attachment struct {
	ID       uuid.UUID `json:"id"`
	AssetID  uuid.UUID `json:"assetId"`
	FieldKey string    `json:"fieldKey"`
}

// View is one saved output view.
type View struct {
	ID             uuid.UUID     `json:"id"`
	Key            string        `json:"key"`
	Name           string        `json:"name"`
	IncludedStates []string      `json:"includedStates"`
	FieldFilters   []FieldFilter `json:"fieldFilters"`
	TimeFilter     TimeFilter    `json:"timeFilter"`
	Sort           []SortRule    `json:"sort"`
	OutputFields   []string      `json:"outputFields"`
	RecordLimit    int           `json:"recordLimit"`
	Position       int           `json:"position"`
}

type FieldFilter struct {
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

// TimeFilter expresses relative time windows such as "start before now, end after now".
type TimeFilter struct {
	Enabled        bool   `json:"enabled"`
	StartField     string `json:"startField,omitempty"`
	EndField       string `json:"endField,omitempty"`
	StartBeforeNow bool   `json:"startBeforeNow,omitempty"`
	EndAfterNow    bool   `json:"endAfterNow,omitempty"`
}

type SortRule struct {
	Field     string `json:"field"`
	Direction string `json:"direction"`
}

// Grant is one per-form access grant.
type Grant struct {
	ID         uuid.UUID  `json:"id"`
	UserID     uuid.UUID  `json:"userId"`
	UserName   string     `json:"userName"`
	Capability Capability `json:"capability"`
}

// AccessEntry is one user's effective access to a form, for the Access tab. Capabilities is the
// collapsed (non-redundant) generating set actually granted; the creator and global Owners appear
// as implicit managers that cannot be removed.
type AccessEntry struct {
	UserID        uuid.UUID    `json:"userId"`
	Name          string       `json:"name"`
	Username      string       `json:"username"`
	Role          string       `json:"role"`
	Capabilities  []Capability `json:"capabilities"`
	IsCreator     bool         `json:"isCreator"`
	IsGlobalOwner bool         `json:"isGlobalOwner"`
}

// DirectoryUser is the minimal user record the manager-scoped directory returns for granting access.
type DirectoryUser struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Username string    `json:"username"`
	Role     string    `json:"role"`
}

// ApprovalItem is one pending record surfaced in the central approvals inbox.
type ApprovalItem struct {
	RecordID      uuid.UUID  `json:"recordId"`
	DataSourceID  uuid.UUID  `json:"dataSourceId"`
	FormName      string     `json:"formName"`
	Title         string     `json:"title"`
	SubmitterName string     `json:"submitterName"`
	State         string     `json:"state"`
	StateLabel    string     `json:"stateLabel"`
	DisplayAt     *time.Time `json:"displayAt,omitempty"`
	ExpiresAt     *time.Time `json:"expiresAt,omitempty"`
	SubmittedAt   time.Time  `json:"submittedAt"`
}

// ApprovalPage is a paginated slice of the central approvals inbox.
type ApprovalPage struct {
	Items    []ApprovalItem `json:"items"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"pageSize"`
}

// SubmissionCounts summarizes a user's own submissions on a form, bucketed by the workflow-derived
// meaning of each state rather than hardcoded state keys: drafts are records in the initial state,
// changesRequested are records in a non-initial editable state (kicked back for edits), and
// submitted covers everything else (in review or decided).
type SubmissionCounts struct {
	Draft            int `json:"draft"`
	Submitted        int `json:"submitted"`
	ChangesRequested int `json:"changesRequested"`
	Total            int `json:"total"`
}

// FormSummary is a lightweight Form entry for the accessible-forms list. It carries just enough to
// render the Forms portal and the operator navigation without loading full form detail.
type FormSummary struct {
	ID                      uuid.UUID        `json:"id"`
	Name                    string           `json:"name"`
	Description             string           `json:"description"`
	PublishedRevisionNumber *int             `json:"publishedRevisionNumber,omitempty"`
	Capabilities            []Capability     `json:"grantedCapabilities"`
	Counts                  SubmissionCounts `json:"submissionCounts"`
}
