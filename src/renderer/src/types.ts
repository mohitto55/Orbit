export type { Domain, SubdomainType } from '../../core/domain'
export type { Spec, Feature, AC, FeatureStatus } from '../../core/spec'
export type { Design } from '../../core/design'
export type { ChangeSet, ChangeInput, ChangeSize } from '../../core/changes'
export type { Review, ReviewItem, Decision } from '../../core/impact'
export type { Task, InboxItem, TaskType, Horizon, TaskStatus, Priority } from '../../core/task'
export type { TestLink, RunSummary, AcStatus, TestRunState, TestRunEvent } from '../../core/verification'
export type { SessionInfo, SessionMessage, Mark, DomainRequest } from '../../core/drift'
export type { Knowledge, KnowledgeType } from '../../core/knowledge'
export type { ProjectSettings } from '../../core/workspace'
export type { TerminalInfo } from '../../core/terminal'
export type { Graph, GNode, GEdge } from '../../core/graph'

export const TASK_TYPES = ['feature', 'bug', 'refactor', 'tech-debt', 'research', 'docs', 'test', 'spec-sync', 'design-sync', 'domain-sync'] as const
export const HORIZONS = ['지금', '다음', '나중', '언젠가'] as const
export const TASK_STATUSES = ['대기', '진행', '완료', '취소'] as const
export const PRIORITIES = ['높음', '보통', '낮음'] as const
export const KN_TYPES = ['결정', '용어', '컨벤션', '교훈', '주의'] as const
export type { Concept, ConceptRelation } from '../../core/model'
export type { AnchorHit } from '../../core/codecheck'
export const CONCEPT_KINDS = ['Entity', 'Value Object', 'Aggregate', 'Event', 'Policy', 'Domain Service'] as const
export type { DomainMap, MapNode, MapEdge, EdgeVia, DomainScope, ScopeNode, ScopeEdge } from '../../core/domainmap'
export type { NodeKind, PipeNode, PipeEdge, Pipeline, RunState, NodeRun } from '../../core/pipeline'
export type { InnerValue } from '../../core/pipeline'
export type { FunctionParam, DataShape } from '../../core/pipeline'
export {
  IF_PORT, COMPARE_OPS, isLogic, isExecPort, defaultValue,
  PARAM_TYPE_NAME,
  AGENT_PORT,
  isAgent,
  edgeShape,
  hasTerminalInput,
  LOOP_PORT,
  isLoopExecPort,
  withInputPort,
  functionParams,
  isFunctionBoundary,
  withFunctionBoundary,
  KIND_NAME,
  SHAPE_NAME,
  TEMPLATE_INPUT,
  TEMPLATE_SEP,
  dataItems,
  dataShape,
  dataValue,
  agentSchema,
  outputRefs,
  edgeProblem,
  fillOutputs,
  hasDataOut,
  hasInput,
  isDataEdge,
  innerValues,
  isData,
  liveNodes,
  newNodeId,
  nodeInput,
  nodeName,
  pipelineProblems,
  specTarget,
  uniqueName
} from '../../core/pipeline'
