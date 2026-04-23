import { invoke } from "@tauri-apps/api/core";
import type {
  Album,
  Burst,
  ClusterResult,
  DbStats,
  DedupStrategy,
  DeleteFilesResult,
  DuplicatesResponse,
  EventSummary,
  FaceDetectProgress,
  FaceInfo,
  FileMetadata,
  FileProperties,
  FilterOption,
  HealthStatus,
  PdfPassword,
  PersonInfo,
  ProtectedPdfInfo,
  PurgeResult,
  ReclusterProgress,
  RenameFileResult,
  RetryProtectedPdfsResult,
  RootInfo,
  RuntimeStatus,
  ScanJobStatus,
  SetupDownloadStatus,
  SetupStatus,
  SmartFolder,
  SubdirEntry,
  Suggestion,
  SuggestedName,
  SearchRequest,
  SearchResponse,
  SavedSearch,
  SavedSearchAlert,
  GpsFile,
  NearbyResult,
  TagRule,
  TimelineBucket,
  TripSummary,
  VenvProvisionStatus,
} from "./types";

export async function appHealth(): Promise<HealthStatus> {
  return invoke<HealthStatus>("app_health");
}

export async function getCliFolderPath(): Promise<string | null> {
  return invoke<string | null>("get_cli_folder_path");
}

export async function ensureDatabase(): Promise<DbStats> {
  return invoke<DbStats>("ensure_database");
}

export async function searchImages(request: SearchRequest): Promise<SearchResponse> {
  return invoke<SearchResponse>("search_images", { request });
}

export async function startScan(rootPath: string, skipClassify?: boolean): Promise<ScanJobStatus> {
  return invoke<ScanJobStatus>("start_scan", { rootPath, skipClassify });
}

export async function getScanJob(jobId: number): Promise<ScanJobStatus | null> {
  return invoke<ScanJobStatus | null>("get_scan_job", { jobId });
}

export async function listActiveScans(): Promise<ScanJobStatus[]> {
  return invoke<ScanJobStatus[]>("list_active_scans");
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("get_runtime_status");
}

export async function getSetupStatus(): Promise<SetupStatus> {
  return invoke<SetupStatus>("get_setup_status");
}

export async function startSetupDownload(): Promise<SetupDownloadStatus> {
  return invoke<SetupDownloadStatus>("start_setup_download");
}

export async function startVenvProvision(): Promise<VenvProvisionStatus> {
  return invoke<VenvProvisionStatus>("start_venv_provision");
}

export async function cancelScan(jobId: number): Promise<boolean> {
  return invoke<boolean>("cancel_scan", { jobId });
}

export async function removeRoot(rootId: number): Promise<PurgeResult> {
  return invoke<PurgeResult>("remove_root", { rootId });
}

export async function listRoots(): Promise<RootInfo[]> {
  return invoke<RootInfo[]>("list_roots");
}

export async function listSubdirectories(rootId: number, parentPrefix: string): Promise<SubdirEntry[]> {
  return invoke<SubdirEntry[]>("list_subdirectories", { rootId, parentPrefix });
}

export async function loadUserConfig(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("load_user_config");
}

export async function saveUserConfig(config: Record<string, unknown>): Promise<void> {
  return invoke<void>("save_user_config", { config });
}

export async function copyFilesToClipboard(paths: string[]): Promise<void> {
  return invoke<void>("copy_files_to_clipboard", { paths });
}

export async function deleteFiles(fileIds: number[]): Promise<DeleteFilesResult> {
  return invoke<DeleteFilesResult>("delete_files", { fileIds });
}

export async function renameFile(fileId: number, newName: string): Promise<RenameFileResult> {
  return invoke<RenameFileResult>("rename_file", { fileId, newName });
}

export async function getFileMetadata(fileId: number): Promise<FileMetadata> {
  return invoke<FileMetadata>("get_file_metadata", { fileId });
}

export async function getFileProperties(fileId: number): Promise<FileProperties> {
  return invoke<FileProperties>("get_file_properties", { fileId });
}

export async function updateFileMetadata(
  fileId: number,
  mediaType: string,
  description: string,
  extractedText: string,
  canonicalMentions: string,
  locationText: string,
): Promise<void> {
  return invoke<void>("update_file_metadata", {
    fileId, mediaType, description, extractedText, canonicalMentions, locationText,
  });
}

// ── Albums ──────────────────────────────────────────────────────────

export async function createAlbum(name: string): Promise<Album> {
  return invoke<Album>("create_album", { name });
}

export async function deleteAlbum(albumId: number): Promise<void> {
  return invoke<void>("delete_album", { albumId });
}

export async function listAlbums(): Promise<Album[]> {
  return invoke<Album[]>("list_albums");
}

export async function addFilesToAlbum(albumId: number, fileIds: number[]): Promise<number> {
  return invoke<number>("add_files_to_album", { albumId, fileIds });
}

export async function updateAlbumTag(albumId: number, tag: string): Promise<void> {
  return invoke<void>("update_album_tag", { albumId, tag });
}

// ── Smart Folders ───────────────────────────────────────────────────

export async function createSmartFolder(name: string, query: string): Promise<SmartFolder> {
  return invoke<SmartFolder>("create_smart_folder", { name, query });
}

export async function deleteSmartFolder(folderId: number): Promise<void> {
  return invoke<void>("delete_smart_folder", { folderId });
}

export async function listSmartFolders(): Promise<SmartFolder[]> {
  return invoke<SmartFolder[]>("list_smart_folders");
}

export async function createFaceSmartAlbum(personName: string): Promise<SmartFolder> {
  return invoke<SmartFolder>("create_face_smart_album", { personName });
}

// ── Tag Rules ───────────────────────────────────────────────────────

export async function listTagRules(): Promise<TagRule[]> {
  return invoke<TagRule[]>("list_tag_rules");
}

export async function createTagRule(pattern: string, tag: string): Promise<TagRule> {
  return invoke<TagRule>("create_tag_rule", { pattern, tag });
}

export async function deleteTagRule(ruleId: number): Promise<void> {
  return invoke<void>("delete_tag_rule", { ruleId });
}

export async function setTagRuleEnabled(ruleId: number, enabled: boolean): Promise<void> {
  return invoke<void>("set_tag_rule_enabled", { ruleId, enabled });
}

// ── Saved Searches ──────────────────────────────────────────────────

export async function listSavedSearches(): Promise<SavedSearch[]> {
  return invoke<SavedSearch[]>("list_saved_searches");
}

export async function createSavedSearch(name: string, query: string): Promise<SavedSearch> {
  return invoke<SavedSearch>("create_saved_search", { name, query });
}

export async function deleteSavedSearch(searchId: number): Promise<void> {
  return invoke<void>("delete_saved_search", { searchId });
}

export async function setSavedSearchNotify(searchId: number, notify: boolean): Promise<void> {
  return invoke<void>("set_saved_search_notify", { searchId, notify });
}

export async function checkSavedSearchAlerts(): Promise<SavedSearchAlert[]> {
  return invoke<SavedSearchAlert[]>("check_saved_search_alerts_cmd");
}

export async function listGpsFiles(rootId?: number | null): Promise<GpsFile[]> {
  return invoke<GpsFile[]>("list_gps_files_cmd", { rootId: rootId ?? null });
}

export async function findNearby(lat: number, lon: number, limit = 50): Promise<NearbyResult[]> {
  return invoke<NearbyResult[]>("find_nearby_cmd", { lat, lon, limit });
}

// ── Duplicates ──────────────────────────────────────────────────────

export async function findDuplicates(
  rootScope: number[] = [],
  nearThreshold?: number | null,
): Promise<DuplicatesResponse> {
  return invoke<DuplicatesResponse>("find_duplicates", {
    rootScope,
    nearThreshold: nearThreshold ?? null,
  });
}

// ── Reorder ─────────────────────────────────────────────────────────

export async function reorderRoots(ids: number[]): Promise<void> {
  return invoke<void>("reorder_roots", { ids });
}

export async function reorderAlbums(ids: number[]): Promise<void> {
  return invoke<void>("reorder_albums", { ids });
}

export async function reorderSmartFolders(ids: number[]): Promise<void> {
  return invoke<void>("reorder_smart_folders", { ids });
}

// ── PDF Passwords ───────────────────────────────────────────────────

export async function addPdfPassword(password: string, label: string): Promise<PdfPassword> {
  return invoke<PdfPassword>("add_pdf_password", { password, label });
}

export async function deletePdfPassword(passwordId: number): Promise<void> {
  return invoke<void>("delete_pdf_password", { passwordId });
}

export async function listPdfPasswords(): Promise<PdfPassword[]> {
  return invoke<PdfPassword[]>("list_pdf_passwords");
}

export async function listProtectedPdfs(): Promise<ProtectedPdfInfo[]> {
  return invoke<ProtectedPdfInfo[]>("list_protected_pdfs");
}

export async function retryProtectedPdfs(): Promise<RetryProtectedPdfsResult> {
  return invoke<RetryProtectedPdfsResult>("retry_protected_pdfs");
}

export async function reclassifyPdf(fileId: number): Promise<boolean> {
  return invoke<boolean>("reclassify_pdf", { fileId });
}

// ── Video ───────────────────────────────────────────────────────────

export async function getVideoStreamUrl(absPath: string): Promise<string> {
  return invoke<string>("get_video_stream_url", { absPath });
}

// ── Face Detection ──────────────────────────────────────────────────

export async function detectFaces(rootId: number): Promise<void> {
  return invoke<void>("detect_faces", { rootId });
}

export async function getFaceDetectStatus(): Promise<FaceDetectProgress | null> {
  return invoke<FaceDetectProgress | null>("get_face_detect_status");
}

export async function cancelFaceDetect(): Promise<boolean> {
  return invoke<boolean>("cancel_face_detect");
}

// ── Person / Clustering ─────────────────────────────────────────────

export async function clusterFaces(): Promise<ClusterResult> {
  return invoke<ClusterResult>("cluster_faces");
}

export async function reclusterFaces(): Promise<void> {
  return invoke<void>("recluster_faces");
}

export async function getReclusterStatus(): Promise<ReclusterProgress | null> {
  return invoke<ReclusterProgress | null>("get_recluster_status");
}

export async function listPersons(rootScope: number[] = []): Promise<PersonInfo[]> {
  return invoke<PersonInfo[]>("list_persons", { rootScope });
}

export async function renamePerson(personId: number, newName: string): Promise<void> {
  return invoke<void>("rename_person", { personId, newName });
}

export async function listFacesForPerson(personId: number): Promise<FaceInfo[]> {
  return invoke<FaceInfo[]>("list_faces_for_person", { personId });
}

export async function unassignFaceFromPerson(faceId: number): Promise<void> {
  return invoke<void>("unassign_face_from_person", { faceId });
}

export async function reassignFacesToPerson(faceIds: number[], targetPersonId: number): Promise<void> {
  return invoke<void>("reassign_faces_to_person", { faceIds, targetPersonId });
}

export async function setRepresentativeFace(personId: number, faceId: number): Promise<void> {
  return invoke<void>("set_representative_face", { personId, faceId });
}

// ── Phase 1/2: EXIF filters, autocomplete, timeline ─────────────────

export async function listCameras(): Promise<FilterOption[]> {
  return invoke<FilterOption[]>("list_cameras_cmd");
}

export async function listLenses(): Promise<FilterOption[]> {
  return invoke<FilterOption[]>("list_lenses_cmd");
}

export async function suggestTags(prefix: string, limit = 8): Promise<Suggestion[]> {
  return invoke<Suggestion[]>("suggest_cmd", { prefix, limit });
}

export async function listTimelineBuckets(): Promise<TimelineBucket[]> {
  return invoke<TimelineBucket[]>("list_timeline_buckets_cmd");
}

// ── Auto-clustering ──────────────────────────────────────────────────

export async function recomputeEvents(): Promise<EventSummary[]> {
  return invoke<EventSummary[]>("recompute_events_cmd");
}

export async function listEvents(): Promise<EventSummary[]> {
  return invoke<EventSummary[]>("list_events_cmd");
}

export async function detectTrips(): Promise<TripSummary[]> {
  return invoke<TripSummary[]>("detect_trips_cmd");
}

export async function listTrips(): Promise<TripSummary[]> {
  return invoke<TripSummary[]>("list_trips_cmd");
}

export async function findBursts(): Promise<Burst[]> {
  return invoke<Burst[]>("find_bursts_cmd");
}

export async function suggestEventNames(): Promise<SuggestedName[]> {
  return invoke<SuggestedName[]>("suggest_event_names_cmd");
}

export async function generateYearReview(year: number): Promise<number> {
  return invoke<number>("generate_year_review_cmd", { year });
}

export async function setDedupPolicy(strategy: DedupStrategy): Promise<void> {
  return invoke<void>("set_dedup_policy_cmd", { strategy });
}

export async function getDedupPolicy(): Promise<DedupStrategy | null> {
  return invoke<DedupStrategy | null>("get_dedup_policy_cmd");
}

export async function applyDedupPolicy(): Promise<number> {
  return invoke<number>("apply_dedup_policy_cmd");
}
