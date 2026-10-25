// List File Volumes: what to show for each generation, no `vscode`.

/** The volumes an RWS 1.0 controller serves, as the client names them. */
export const RWS1_VOLUMES: readonly string[] = ['$HOME', '$TEMP', '$BACKUP'];

export interface VolumeList { volumes: string[]; note?: string }

const DRIVE_LETTER = /^[A-Za-z]:\\?$/;

/**
 * An RWS 1.0 virtual controller answers GET /fileservice with the PC's own
 * drives (C:, D:) as fs-device entries. Those are not the controller's file
 * volumes, so they are replaced by the volumes RWS 1.0 serves. Any other
 * answer, and every RWS 2.0 answer, is shown as received.
 */
export function volumesToShow(generation: 'rw6' | 'rw7' | 'rw8' | null, listed: string[]): VolumeList {
  if (generation !== 'rw6') { return { volumes: listed }; }
  if (listed.length === 0) { return { volumes: [...RWS1_VOLUMES] }; }
  if (listed.every(v => DRIVE_LETTER.test(v))) {
    return {
      volumes: [...RWS1_VOLUMES],
      note: `The controller listed this PC's drives (${listed.join(', ')}); these are the controller's own volumes.`,
    };
  }
  return { volumes: listed };
}

export function fileVolumesText(list: VolumeList): string {
  const body = `# File volumes\n\n${list.volumes.map(v => `- ${v}`).join('\n')}`;
  return list.note ? `${body}\n\n${list.note}` : body;
}
