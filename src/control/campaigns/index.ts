/**
 * The campaigns control keeps: a new one from the new-campaign page (new.ts, with builder.ts), a
 * copy (copy.ts), Start a run (start-run.ts) and the queue it copies from a past run
 * (queue-copy.ts), a campaign's context settings (context.ts), the owner's additions to its roles
 * (additions.ts), which roles write in its collection of the knowledge base (kb-writes.ts), and
 * archive and folders (folders.ts).
 */

export {
  CampaignAdditionsBody,
  campaignAdditionsAnswer,
  campaignAdditionsFields,
  contractAdditions,
  setCampaignAdditions,
} from "./additions.ts";
export {
  CampaignContextBody,
  campaignContextAnswer,
  campaignContextFields,
  campaignContextRefusal,
  campaignContract,
  contractContext,
  type OwnModel,
  ownModels,
  type RigContext,
  rigContext,
  setCampaignContext,
} from "./context.ts";
export {
  CopyCampaignBody,
  type CopyCampaignOutcome,
  type CopyCampaignRequest,
  copiedFromWords,
  copiedMcpWords,
  copyACampaign,
  copyCampaignAnswer,
  copyCampaignFields,
} from "./copy.ts";
export {
  archiveCampaign,
  campaignFoldersAnswer,
  createFolder,
  deleteFolder,
  FOLDER_NAME_MAX,
  FolderNameBody,
  MoveBody,
  moveCampaign,
  renameFolder,
  type ShelfOutcome,
  unarchiveCampaign,
} from "./folders.ts";
export {
  CampaignKbWritesBody,
  campaignKbWrites,
  campaignKbWritesAnswer,
  campaignKbWritesFields,
  defaultWords as kbWritesDefaultWords,
  setCampaignKbWrites,
} from "./kb-writes.ts";
export { askOwnerFrom, startCampaign } from "./new.ts";
export { copiedFromRecords, queueFromRecords, untriedOf } from "./queue-copy.ts";
export {
  bodyRefusal,
  StartRunBody,
  type StartRunRequest,
  startARun,
  startRunAnswer,
  startRunFields,
  startRunRequest,
} from "./start-run.ts";
