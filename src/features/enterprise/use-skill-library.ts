import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersonalSkillVersionRequest } from '../../shared/platform-supplement-contracts';
import type { SaveSkillResult, SkillLibraryItem } from '../../shared/skill-library';

/** Server metadata and durable local versions only. No browser-side skill copies. */
export function useSkillLibrary(scopeKey: string) {
  const [skills, setSkills] = useState<SkillLibraryItem[]>([]);
  const [skillsLoading, setLoading] = useState(true);
  const [skillsError, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refreshSkills = useCallback(async (): Promise<void> => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await window.electronAPI.listSkillLibrary();
      if (!result.success || !result.data) throw new Error(result.error?.message || '技能加载失败');
      if (generation.current === request) { setSkills(result.data); setError(null); }
    } catch (error) {
      if (generation.current === request) setError(error instanceof Error ? error.message : '技能加载失败');
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, []);
  useEffect(() => {
    setSkills([]);
    void refreshSkills();
    const refresh = () => { void refreshSkills(); };
    window.addEventListener('focus', refresh);
    return () => { generation.current += 1; window.removeEventListener('focus', refresh); };
  }, [scopeKey, refreshSkills]);

  const previewSkillSource = useCallback(async (capabilityId: string, versionId: string): Promise<string> => {
    const result = await window.electronAPI.previewLibrarySkill({ capabilityId, versionId });
    if (!result.success || result.data === undefined) throw new Error(result.error?.message || '原文读取失败');
    return result.data;
  }, []);
  const selectSkillVersion = useCallback(async (capabilityId: string, versionId: string): Promise<void> => {
    const result = await window.electronAPI.selectSkillVersion({ capabilityId, versionId });
    if (!result.success) throw new Error(result.error?.message || '版本切换失败');
    setSkills(current => current.map(item => item.capability.id === capabilityId ? { ...item, bindings: item.bindings.map(binding => ({ ...binding, selectedVersionId: versionId })) } : item));
    await refreshSkills();
  }, [refreshSkills]);
  const saveSkillSource = useCallback(async (request: PersonalSkillVersionRequest, idempotencyKey: string): Promise<SaveSkillResult> => {
    const result = await window.electronAPI.savePersonalSkill({ request, idempotencyKey });
    if (!result.success || !result.data) throw new Error(result.error?.message || '保存失败，原文未丢失，请重试');
    const saved = result.data;
    // The durable save succeeded; a failed metadata refresh must not hide the new version.
    setSkills(current => current.map(item => item.capability.id !== request.capabilityId ? item : {
      ...item,
      versions: saved.version ? [...item.versions.filter(version => version.id !== saved.version!.id), saved.version] : item.versions,
      usableVersionIds: [...new Set([...item.usableVersionIds, idempotencyKey])],
      localVersions: [...item.localVersions.filter(local => local.idempotencyKey !== idempotencyKey), {
        request, idempotencyKey,
        createdAt: item.localVersions.find(local => local.idempotencyKey === idempotencyKey)?.createdAt ?? new Date().toISOString(),
        ...(saved.version ? { uploadedVersion: saved.version } : {}),
      }],
    }));
    await refreshSkills();
    return saved;
  }, [refreshSkills]);
  const retrySkillUpload = useCallback(async (capabilityId: string, idempotencyKey: string): Promise<SaveSkillResult> => {
    const result = await window.electronAPI.retryPersonalSkillUpload({ capabilityId, idempotencyKey });
    if (!result.success || !result.data) throw new Error(result.error?.message || '上传失败');
    const saved = result.data;
    if (saved.version) setSkills(current => current.map(item => item.capability.id !== capabilityId ? item : {
      ...item, versions: [...item.versions.filter(version => version.id !== saved.version!.id), saved.version!],
      localVersions: item.localVersions.map(local => local.idempotencyKey === idempotencyKey ? { ...local, uploadedVersion: saved.version } : local),
    }));
    await refreshSkills();
    return result.data;
  }, [refreshSkills]);
  return { skills, skillsLoading, skillsError, refreshSkills, previewSkillSource, selectSkillVersion, saveSkillSource, retrySkillUpload };
}
export type SkillLibraryWorkspace = ReturnType<typeof useSkillLibrary>;
