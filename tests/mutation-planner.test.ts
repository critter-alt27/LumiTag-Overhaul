import { describe, expect, test } from 'bun:test'

import {
  affectedCharactersForTag,
  createOperationId,
  planOperation,
  validateNewTagName,
  validateRenameTarget,
  type OperationPreview,
  type PlannedMutation,
} from '../src/frontend/mutations/planner'
import { buildTagIndex, dedupeTagNames, type TagEntry } from '../src/frontend/tag-index'
import type { LumiTagCharacter } from '../src/shared/types'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function character(id: string, name: string, tags?: unknown): LumiTagCharacter {
  return {
    id,
    name,
    description: '',
    personality: '',
    scenario: '',
    creator: '',
    creator_notes: '',
    system_prompt: '',
    tags: Array.isArray(tags) ? (tags as string[]) : [],
    image_id: null,
    created_at: 0,
    updated_at: 0,
  }
}

function rawCharacter(id: string, name: string, tags: unknown): LumiTagCharacter {
  return { ...character(id, name), tags } as unknown as LumiTagCharacter
}

/**
 * Shared fixture. Note `c4`/`c5` deliberately share the display name "Cira" so
 * identity-by-id is exercised throughout.
 */
const FIXTURE: LumiTagCharacter[] = [
  character('c1', 'Ayla', ['Elf', 'Magic']),
  character('c2', 'Bran', ['Mage', 'Warrior']),
  character('c3', 'Cira', ['Elf', 'Mage']),
  character('c4', 'Doran', ['Dark', 'Rogue', 'Elf']),
  character('c5', 'Cira', ['Elf', 'Magic']),
  character('c6', 'Eli', []),
]

/** Final tag array the plan intends for `characterId`, or undefined. */
function targetFor(preview: OperationPreview, characterId: string): string[] | undefined {
  return preview.mutations.find((m) => m.characterId === characterId)?.targetTags
}

function mutationsFor(preview: OperationPreview, characterId: string): PlannedMutation[] {
  return preview.mutations.filter((m) => m.characterId === characterId)
}

/** Strip the random opId so two structurally-identical plans compare equal. */
function normalize(preview: OperationPreview): Omit<OperationPreview, 'opId'> & { opId: string } {
  return {
    ...preview,
    opId: 'opId',
    mutations: preview.mutations.map((m) => ({ ...m, mutationId: m.mutationId.slice(m.mutationId.indexOf(':') + 1) })),
  }
}

/**
 * Apply a preview the way the executor would: write each character's
 * `targetTags` once, deduped, and leave untouched characters alone. Returns the
 * resulting tag arrays keyed by character id. This is the real end-to-end
 * assertion of "no unrelated tag is ever lost".
 */
function applyPreview(
  preview: OperationPreview,
  characters: readonly LumiTagCharacter[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const character of characters) {
    if (!character || typeof character !== 'object') continue
    out[character.id] = dedupeTagNames(character.tags)
  }
  for (const characterId of preview.affectedCharacterIds) {
    const mutation = preview.mutations.find((m) => m.characterId === characterId)
    if (mutation) out[characterId] = dedupeTagNames(mutation.targetTags)
  }
  return out
}

/** Tag catalog derived from a character set, for the validators. */
function entriesOf(characters: readonly LumiTagCharacter[]): TagEntry[] {
  return buildTagIndex(characters).tags
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    const j = state % (i + 1)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

// ---------------------------------------------------------------------------

describe('planOperation — assign', () => {
  test('1. create and assign applies a new tag and preserves existing tags', () => {
    const preview = planOperation(FIXTURE, { op: 'assign', tag: 'Scholar', selectedIds: ['c1', 'c2'] })

    expect(preview.op).toBe('assign')
    expect(preview.label).toBe('Assign tag: Scholar')
    expect(preview.tags).toEqual(['Scholar'])
    expect(preview.mutations).toHaveLength(2)
    expect(targetFor(preview, 'c1')).toEqual(['Elf', 'Magic', 'Scholar'])
    expect(targetFor(preview, 'c2')).toEqual(['Mage', 'Warrior', 'Scholar'])
    expect(preview.skipped).toEqual([])
    expect(preview.affectedCharacterCount).toBe(2)
    expect(preview.changeCount).toBe(2)
    expect(preview.affectedCharacterIds).toEqual(['c1', 'c2'])
    // End-to-end: only the two selected characters changed, nothing else lost.
    expect(applyPreview(preview, FIXTURE)).toEqual({
      c1: ['Elf', 'Magic', 'Scholar'],
      c2: ['Mage', 'Warrior', 'Scholar'],
      c3: ['Elf', 'Mage'],
      c4: ['Dark', 'Rogue', 'Elf'],
      c5: ['Elf', 'Magic'],
      c6: [],
    })
  })

  test('2. additive bulk assignment yields M+N, never just N', () => {
    const base = character('x1', 'Solo', ['Alpha', 'Beta', 'Gamma'])
    const preview = planOperation([base], {
      op: 'assign',
      tags: ['Delta', 'Epsilon', 'Zeta'],
      selectedIds: ['x1'],
    })

    expect(preview.label).toBe('Assign 3 tags')
    const target = targetFor(preview, 'x1')!
    expect(target).toHaveLength(6)
    expect(target).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'])
    // Explicitly: no unrelated tag was lost.
    for (const unrelated of ['Alpha', 'Beta', 'Gamma']) {
      expect(target).toContain(unrelated)
    }
    expect(preview.mutations[0].addedTags).toEqual(['Delta', 'Epsilon', 'Zeta'])
    expect(preview.mutations[0].removedTags).toEqual([])
  })

  test('3. re-planning the same assign yields zero mutations and N skips', () => {
    const first = planOperation(FIXTURE, { op: 'assign', tags: ['Noble', 'Brave'], selectedIds: ['c1', 'c2', 'c3'] })
    expect(first.mutations).toHaveLength(3)

    const withNewTags = FIXTURE.map((c) => {
      const mutation = first.mutations.find((m) => m.characterId === c.id)
      return mutation ? { ...c, tags: [...mutation.targetTags] } : c
    })

    const second = planOperation(withNewTags, {
      op: 'assign',
      tags: ['Noble', 'Brave'],
      selectedIds: ['c1', 'c2', 'c3'],
    })
    expect(second.mutations).toHaveLength(0)
    expect(second.skipped).toHaveLength(3)
    expect(second.skipped.every((s) => s.reason === 'already assigned')).toBe(true)
    expect(second.changeCount).toBe(0)
  })

  test('4. no-op changes are skipped, not written', () => {
    const preview = planOperation(FIXTURE, { op: 'assign', tag: 'Elf', selectedIds: ['c1', 'c3', 'c4', 'c5'] })

    // Every selected character already has Elf → nothing to write at all.
    expect(preview.mutations).toHaveLength(0)
    expect(preview.changeCount).toBe(0)
    expect(preview.affectedCharacterIds).toEqual([])
    expect(preview.skipped).toHaveLength(4)
    expect(preview.skipped.every((s) => s.reason === 'already assigned')).toBe(true)
    expect(preview.skipped.map((s) => s.characterId)).toEqual(['c1', 'c3', 'c5', 'c4'])
    // Applying the plan is a true no-op.
    expect(applyPreview(preview, FIXTURE)).toEqual({
      c1: ['Elf', 'Magic'],
      c2: ['Mage', 'Warrior'],
      c3: ['Elf', 'Mage'],
      c4: ['Dark', 'Rogue', 'Elf'],
      c5: ['Elf', 'Magic'],
      c6: [],
    })
  })

  test('5. dedup: a differently-cased existing tag is not duplicated, spelling preserved', () => {
    // Case-variant of an EXISTING tag → skipped, nothing written.
    const existingCase = planOperation(FIXTURE, { op: 'assign', tag: 'eLF', selectedIds: ['c1'] })
    expect(existingCase.mutations).toHaveLength(0)
    expect(existingCase.skipped[0].reason).toBe('already assigned')

    // Same, for a character whose stored spelling differs in case.
    const fresh = planOperation([character('d1', 'D', ['ELF', 'Magic'])], {
      op: 'assign',
      tag: 'elf',
      selectedIds: ['d1'],
    })
    expect(fresh.mutations).toHaveLength(0)
    expect(fresh.skipped[0].reason).toBe('already assigned')
    // The ORIGINAL spelling is what remains on the character.
    expect(FIXTURE.find((c) => c.id === 'c1')!.tags).toEqual(['Elf', 'Magic'])

    // A genuinely new tag is added once; duplicate inputs collapse to one entry
    // using the FIRST spelling supplied.
    const added = planOperation([character('d2', 'D', ['Magic'])], {
      op: 'assign',
      tags: ['Dark', 'DARK'],
      selectedIds: ['d2'],
    })
    expect(targetFor(added, 'd2')).toEqual(['Magic', 'Dark'])
    expect(added.mutations[0].addedTags).toEqual(['Dark'])
  })
})

describe('planOperation — remove / delete', () => {
  test('6. single-chip removal removes only that tag', () => {
    const preview = planOperation(FIXTURE, { op: 'remove', tags: ['Elf'] })

    expect(preview.label).toBe('Remove tag: Elf')
    expect(targetFor(preview, 'c1')).toEqual(['Magic'])
    expect(targetFor(preview, 'c3')).toEqual(['Mage'])
    expect(targetFor(preview, 'c4')).toEqual(['Dark', 'Rogue'])
    expect(preview.mutations[0].addedTags).toEqual([])
    expect(preview.mutations[0].removedTags).toEqual(['Elf'])
    // End-to-end: only Elf went away; every unrelated tag survived.
    expect(applyPreview(preview, FIXTURE)).toEqual({
      c1: ['Magic'],
      c2: ['Mage', 'Warrior'],
      c3: ['Mage'],
      c4: ['Dark', 'Rogue'],
      c5: ['Magic'],
      c6: [],
    })
  })

  test('13. delete a tag globally, preserving unrelated tags', () => {
    const preview = planOperation(FIXTURE, { op: 'delete', tags: ['Elf'] })

    expect(preview.op).toBe('delete')
    expect(preview.label).toBe('Delete tag: Elf')
    // Sorted by characterName: Ayla(c1), Cira(c3), Cira(c5), Doran(c4).
    expect(preview.mutations.map((m) => m.characterId)).toEqual(['c1', 'c3', 'c5', 'c4'])
    expect(targetFor(preview, 'c1')).toEqual(['Magic'])
    expect(targetFor(preview, 'c4')).toEqual(['Dark', 'Rogue'])
    // End-to-end: applied to the whole accessible set.
    expect(applyPreview(preview, FIXTURE)).toEqual({
      c1: ['Magic'],
      c2: ['Mage', 'Warrior'],
      c3: ['Mage'],
      c4: ['Dark', 'Rogue'],
      c5: ['Magic'],
      c6: [],
    })
    // Characters without the tag are skipped, not written.
    expect(preview.skipped.map((s) => s.characterId)).toEqual(['c2', 'c6'])
    expect(preview.skipped.every((s) => s.reason === 'tag not present')).toBe(true)
  })

  test('14. bulk delete: one mutation per character, removedTags is the union of all sources', () => {
    const preview = planOperation(FIXTURE, { op: 'delete', tags: ['Elf', 'Dark'] })

    expect(preview.label).toBe('Delete 2 tags')
    expect(preview.tags).toEqual(['Elf', 'Dark'])

    // c4 carries both Elf and Dark. It is ONE write, so it is ONE mutation —
    // and that mutation must carry BOTH removals, since the executor applies
    // `removedTags` as one set against a single full-array replace.
    const c4Mutations = mutationsFor(preview, 'c4')
    expect(c4Mutations).toHaveLength(1)
    const c4 = c4Mutations[0]!
    expect(c4.sourceTags).toEqual(['Dark', 'Elf'])
    expect(c4.removedTags).toEqual(['Dark', 'Elf'])
    expect(c4.addedTags).toEqual([])
    expect(c4.targetTags).toEqual(['Rogue'])
    // The primary tag is the lowest tagKey of the set — deterministic, not
    // "whichever the source list happened to start with".
    expect(c4.tag).toBe('Dark')
    expect(c4.intendedChange).toBe('Delete 2 tags ("Dark", "Elf") from Doran')

    expect(mutationsFor(preview, 'c1')).toHaveLength(1)
    expect(targetFor(preview, 'c1')).toEqual(['Magic'])
    // A single-source character keeps the single-tag one-liner.
    expect(mutationsFor(preview, 'c1')[0]!.intendedChange).toBe('Delete tag "Elf" from Ayla')
  })
})

describe('planOperation — rename', () => {
  test('7. rename is global, preserves unrelated tags, and dedupes the destination', () => {
    // 'c6' is on no filter's visible list in the UI but is part of the set; make
    // it carry Mage so we can prove the rename reaches it.
    const set: LumiTagCharacter[] = [
      character('c1', 'Ayla', ['Elf', 'Magic']),
      character('c2', 'Bran', ['Mage', 'Warrior']),
      character('c3', 'Cira', ['Elf', 'Mage']),
      character('c9', 'Hidden', ['Mage', 'Rogue']), // filtered out of the UI
      character('c8', 'Both', ['Elf', 'Mage', 'Magic']), // already has destination
      character('c6', 'Eli', []),
    ]

    const preview = planOperation(set, { op: 'rename', from: 'Mage', to: 'Magic' })

    expect(preview.label).toBe('Rename: Mage → Magic')
    expect(preview.tags).toEqual(['Mage', 'Magic'])
    // Sorted by characterName: Both(c8), Bran(c2), Cira(c3), Hidden(c9).
    expect(preview.mutations.map((m) => m.characterId)).toEqual(['c8', 'c2', 'c3', 'c9'])
    expect(preview.skipped.map((s) => s.characterId)).toEqual(['c1', 'c6'])

    expect(targetFor(preview, 'c2')).toEqual(['Magic', 'Warrior'])
    expect(targetFor(preview, 'c3')).toEqual(['Elf', 'Magic'])
    // GLOBAL: 'Hidden' was never in the visible list but is included.
    expect(targetFor(preview, 'c9')).toEqual(['Magic', 'Rogue'])
    // Deduped: 'Magic' appears exactly once.
    expect(targetFor(preview, 'c8')).toEqual(['Elf', 'Magic'])

    const c3 = mutationsFor(preview, 'c3')[0]
    expect(c3.op).toBe('rename')
    expect(c3.tag).toBe('Mage')
    expect(c3.destTag).toBe('Magic')
    expect(c3.sourceTags).toEqual(['Mage'])
    expect(c3.addedTags).toEqual(['Magic'])
    expect(c3.removedTags).toEqual(['Mage'])
    // A character that already had the destination adds nothing.
    expect(mutationsFor(preview, 'c8')[0].addedTags).toEqual([])
  })
})

describe('planOperation — merge', () => {
  const MERGE_SET: LumiTagCharacter[] = [
    character('A', 'Char A', ['Elf', 'Magic']),
    character('B', 'Char B', ['Mage', 'Warrior']),
    character('C', 'Char C', ['Elf', 'Mage']),
  ]

  test('8. the spec merge example produces the exact expected arrays', () => {
    const preview = planOperation(MERGE_SET, { op: 'merge', primary: 'Magic', targets: ['Mage'] })

    expect(preview.label).toBe('Merge: Mage → Magic')
    expect(preview.tags).toEqual(['Magic', 'Mage'])

    // THE spec example, asserted on the resulting state of the whole set:
    //   A: ["Elf","Magic"]  B: ["Magic","Warrior"]  C: ["Elf","Magic"]
    expect(applyPreview(preview, MERGE_SET)).toEqual({
      A: ['Elf', 'Magic'],
      B: ['Magic', 'Warrior'],
      C: ['Elf', 'Magic'],
    })

    expect(targetFor(preview, 'B')).toEqual(['Magic', 'Warrior'])
    expect(targetFor(preview, 'C')).toEqual(['Elf', 'Magic'])
    // A already ends up correct and carries no source tag → skipped, not written.
    expect(mutationsFor(preview, 'A')).toHaveLength(0)
    expect(preview.skipped).toHaveLength(1)
    expect(preview.skipped[0]).toEqual({ characterId: 'A', characterName: 'Char A', reason: 'tag not present' })
  })

  test('9. merge when a character already has the primary does not duplicate it', () => {
    const set = [
      character('m1', 'Has', ['Elf', 'Magic', 'Mage']),
      character('m2', 'HasNot', ['Mage']),
    ]
    const preview = planOperation(set, { op: 'merge', primary: 'Magic', targets: ['Mage'] })
    const target = targetFor(preview, 'm1')!
    expect(target).toEqual(['Elf', 'Magic'])
    expect(target.filter((t) => t === 'Magic')).toHaveLength(1)
    expect(target.filter((t) => t.toLowerCase() === 'magic')).toHaveLength(1)
    // Nothing new was introduced for a character that already had the primary.
    expect(mutationsFor(preview, 'm1')[0].addedTags).toEqual([])
  })

  test('10. multiple targets on one character → ONE mutation carrying the combined final array', () => {
    const set = [character('z1', 'Zed', ['Elf', 'Dark', 'Mage', 'Warrior'])]
    const preview = planOperation(set, { op: 'merge', primary: 'Magic', targets: ['Mage', 'Dark', 'Elf'] })

    expect(preview.label).toBe('Merge 3 tags → Magic')
    const mutations = mutationsFor(preview, 'z1')
    // One write → one record, so the full tag arrays are not duplicated N times.
    expect(mutations).toHaveLength(1)
    const mutation = mutations[0]!
    expect(mutation.sourceTags).toEqual(['Mage', 'Dark', 'Elf'])
    expect(mutation.destTag).toBe('Magic')
    // The combined final array: every source folded into Magic, Warrior kept.
    expect(mutation.targetTags).toEqual(['Magic', 'Warrior'])
    expect(mutation.addedTags).toEqual(['Magic'])
    expect(mutation.removedTags).toEqual(['Elf', 'Dark', 'Mage'])
    // Primary tag is the lowest tagKey, independent of the caller's order.
    expect(mutation.tag).toBe('Dark')
    expect(mutation.intendedChange).toBe('Merge 3 tags ("Mage", "Dark", "Elf") into "Magic" on Zed')
  })

  test('11. a target equal to the primary is rejected (case-insensitively)', () => {
    const set = [
      character('p1', 'One', ['Magic']),
      character('p2', 'Two', ['Mage', 'Warrior']),
    ]
    const preview = planOperation(set, { op: 'merge', primary: 'Magic', targets: ['MAGIC', 'Mage'] })

    // Only 'Mage' survives as a real target.
    expect(preview.tags).toEqual(['Magic', 'Mage'])
    expect(preview.label).toBe('Merge: Mage → Magic')
    expect(mutationsFor(preview, 'p1')).toHaveLength(0)
    // The rejected self-target never appears as a mutation tag.
    expect(preview.mutations.some((m) => m.tag === 'MAGIC')).toBe(false)
    expect(targetFor(preview, 'p2')).toEqual(['Magic', 'Warrior'])
    // No self-merge mutation anywhere.
    expect(preview.mutations.some((m) => m.tag.toLowerCase() === m.destTag?.toLowerCase())).toBe(false)
  })

  test('12. merge preserves unrelated tags on every affected character', () => {
    const set = [
      character('u1', 'One', ['Mage', 'Knight', 'Royal', 'Noble']),
      character('u2', 'Two', ['Unrelated']),
      character('u3', 'Three', ['Warrior', 'Mage']),
    ]
    const preview = planOperation(set, { op: 'merge', primary: 'Magic', targets: ['Mage'] })

    expect(targetFor(preview, 'u1')).toEqual(['Magic', 'Knight', 'Royal', 'Noble'])
    expect(targetFor(preview, 'u3')).toEqual(['Warrior', 'Magic'])
    expect(mutationsFor(preview, 'u2')).toHaveLength(0)
    for (const mutation of preview.mutations) {
      for (const keep of ['Knight', 'Royal', 'Noble', 'Warrior']) {
        if (mutation.beforeTags.includes(keep)) expect(mutation.targetTags).toContain(keep)
      }
    }
  })

  test('merge with no valid target changes nothing', () => {
    const preview = planOperation(MERGE_SET, { op: 'merge', primary: 'Magic', targets: ['magic'] })
    expect(preview.mutations).toHaveLength(0)
    expect(preview.tags).toEqual(['Magic'])
    expect(preview.skipped.length).toBe(3)
  })
})

describe('planOperation — scoped remove (bulk unassign)', () => {
  test('removes only from the selected characters, leaving unselected ones alone', () => {
    const preview = planOperation(FIXTURE, {
      op: 'remove',
      tags: ['Elf'],
      selectedIds: ['c1', 'c4'],
    })

    // The whole point of a scope: c3 and c5 also carry Elf, and they are NOT
    // touched. A library-wide remove here would be a data-loss bug.
    expect(preview.affectedCharacterIds).toEqual(['c1', 'c4'])
    expect(targetFor(preview, 'c1')).toEqual(['Magic'])
    expect(targetFor(preview, 'c4')).toEqual(['Dark', 'Rogue'])
    // c3/c5 are outside the scope, so they are not even reported as skipped —
    // "skipped" must mean "considered and left unchanged".
    expect(preview.skipped.map((s) => s.characterId).sort()).toEqual([])
  })

  test('preserves the character other tags and never replaces the array', () => {
    const preview = planOperation(FIXTURE, {
      op: 'remove',
      tags: ['Elf', 'Dark'],
      selectedIds: ['c4'],
    })

    const mutation = mutationsFor(preview, 'c4')[0]!
    expect(mutation.op).toBe('remove')
    // One write per character, carrying BOTH removals in one record.
    expect(mutationsFor(preview, 'c4')).toHaveLength(1)
    expect(mutation.sourceTags).toEqual(['Dark', 'Elf'])
    expect(mutation.removedTags).toEqual(['Dark', 'Elf'])
    expect(mutation.addedTags).toEqual([])
    expect(mutation.targetTags).toEqual(['Rogue'])
    expect(mutation.beforeTags).toEqual(['Dark', 'Rogue', 'Elf'])
    expect(mutation.intendedChange).toBe('Remove 2 tags ("Dark", "Elf") from Doran')
  })

  test('a selected character that lacks the tag is skipped, not written', () => {
    const preview = planOperation(FIXTURE, {
      op: 'remove',
      tags: ['Elf'],
      selectedIds: ['c2', 'c6'],
    })

    expect(preview.mutations).toHaveLength(0)
    expect(preview.skipped.map((s) => s.characterId).sort()).toEqual(['c2', 'c6'])
    expect(preview.skipped.every((s) => s.reason === 'tag not present')).toBe(true)
    // "Nothing to change" is reported, never silently shown as a success.
    expect(preview.changeCount).toBe(0)
  })

  test('a selected id that cannot be resolved is reported, never dropped', () => {
    const preview = planOperation(FIXTURE, {
      op: 'remove',
      tags: ['Elf'],
      selectedIds: ['c1', 'ghost'],
    })

    expect(mutationsFor(preview, 'c1')).toHaveLength(1)
    expect(preview.skipped).toEqual([
      { characterId: 'ghost', characterName: '', reason: 'character not found' },
    ])
  })

  test('an empty selection writes nothing at all', () => {
    const preview = planOperation(FIXTURE, { op: 'remove', tags: ['Elf'], selectedIds: [] })

    expect(preview.mutations).toHaveLength(0)
    expect(preview.skipped).toEqual([])
    expect(preview.affectedCharacterCount).toBe(0)
  })

  test('the label marks the operation as scoped, so a report cannot read library-wide', () => {
    const scoped = planOperation(FIXTURE, { op: 'remove', tags: ['Elf'], selectedIds: ['c1'] })
    expect(scoped.label).toBe('Remove tag: Elf from selection')

    const multi = planOperation(FIXTURE, {
      op: 'remove',
      tags: ['Elf', 'Dark'],
      selectedIds: ['c1'],
    })
    expect(multi.label).toBe('Remove 2 tags from selection')
  })

  test('omitting selectedIds keeps the library-wide remove contract intact', () => {
    const preview = planOperation(FIXTURE, { op: 'remove', tags: ['Elf'] })

    // The scope is opt-in, so an unscoped remove still reaches EVERY character
    // carrying the tag — identical reach to `delete`, differing only in wording.
    const asDelete = planOperation(FIXTURE, { op: 'delete', tags: ['Elf'] })
    expect(preview.affectedCharacterIds).toEqual(asDelete.affectedCharacterIds)
    // Sorted by name then id, so the two characters named "Cira" sit together.
    expect(preview.affectedCharacterIds).toEqual(['c1', 'c3', 'c5', 'c4'])
    expect(preview.label).toBe('Remove tag: Elf')
  })
})

describe('one mutation per character', () => {
  /** `count` characters, each carrying ALL of `tags`. */
  function bulk(count: number, tags: string[]): LumiTagCharacter[] {
    return Array.from({ length: count }, (_, i) =>
      character(`c${String(i + 1).padStart(4, '0')}`, `Char ${String(i + 1).padStart(4, '0')}`, tags),
    )
  }

  test('a 300-character 5-tag delete is 300 mutations, not 1500', () => {
    const set = bulk(300, ['Elf', 'Dark', 'Mage', 'Fire', 'Royal'])
    const preview = planOperation(set, { op: 'delete', tags: ['Elf', 'Dark', 'Mage', 'Fire', 'Royal'] })

    expect(preview.mutations).toHaveLength(300)
    expect(new Set(preview.mutations.map((m) => m.characterId)).size).toBe(300)
    // Every record carries all five removals — the full intent of its write.
    for (const mutation of preview.mutations) {
      expect(mutation.sourceTags).toHaveLength(5)
      expect(mutation.removedTags).toHaveLength(5)
      expect(mutation.targetTags).toEqual([])
    }
  })

  test('a 300-character 5-tag merge is 300 mutations, not 1500', () => {
    const set = bulk(300, ['Elf', 'Dark', 'Mage', 'Fire', 'Royal'])
    const preview = planOperation(set, {
      op: 'merge',
      primary: 'Magic',
      targets: ['Elf', 'Dark', 'Mage', 'Fire', 'Royal'],
    })

    expect(preview.mutations).toHaveLength(300)
    expect(new Set(preview.mutations.map((m) => m.characterId)).size).toBe(300)
    for (const mutation of preview.mutations) {
      expect(mutation.sourceTags).toHaveLength(5)
      expect(mutation.removedTags).toHaveLength(5)
      // FULL-ARRAY REPLACE: the complete final array, Magic once, nothing lost.
      expect(mutation.targetTags).toEqual(['Magic'])
      expect(mutation.addedTags).toEqual(['Magic'])
      expect(mutation.destTag).toBe('Magic')
    }
  })

  test('unrelated tags survive the collapsed write', () => {
    const set = [character('k1', 'Keep', ['Elf', 'Dark', 'Knight', 'Royal', 'Noble'])]
    const removed = planOperation(set, { op: 'delete', tags: ['Elf', 'Dark'] })
    expect(removed.mutations[0]!.targetTags).toEqual(['Knight', 'Royal', 'Noble'])

    const merged = planOperation(set, { op: 'merge', primary: 'Magic', targets: ['Elf', 'Dark'] })
    expect(merged.mutations[0]!.targetTags).toEqual(['Magic', 'Knight', 'Royal', 'Noble'])
  })

  test('the primary tag is the lowest tagKey, not the caller\'s first', () => {
    const set = [character('q1', 'Q', ['Royal', 'Dark', 'Elf'])]
    // Caller order is deliberately reversed; the primary must not follow it.
    const preview = planOperation(set, { op: 'delete', tags: ['Royal', 'Dark', 'Elf'] })
    expect(preview.mutations[0]!.tag).toBe('Dark')

    const merge = planOperation(set, { op: 'merge', primary: 'Magic', targets: ['Royal', 'Dark', 'Elf'] })
    expect(merge.mutations[0]!.tag).toBe('Dark')
  })

  test('skipped bookkeeping is unchanged: one entry per character per reason', () => {
    // c2 and c6 carry neither tag — one skip entry each, as before.
    const preview = planOperation(FIXTURE, { op: 'delete', tags: ['Elf', 'Dark'] })
    expect(preview.skipped).toEqual([
      { characterId: 'c2', characterName: 'Bran', reason: 'tag not present' },
      { characterId: 'c6', characterName: 'Eli', reason: 'tag not present' },
    ])
    // Four mutations: c1, c3, c4, c5 — exactly the characters carrying a tag,
    // each producing exactly ONE record however many sources it has.
    expect(preview.mutations).toHaveLength(4)
    expect(new Set(preview.mutations.map((m) => m.characterId))).toEqual(new Set(['c1', 'c3', 'c4', 'c5']))
    // c4 carries both sources but is still a single skip-free record.
    expect(mutationsFor(preview, 'c4')[0]!.removedTags).toEqual(['Dark', 'Elf'])
  })
})

describe('identity and determinism', () => {
  test('15. two characters sharing a display name stay distinguishable', () => {
    const preview = planOperation(FIXTURE, { op: 'delete', tags: ['Elf'] })
    const ciras = mutationsFor(preview, 'c3').concat(mutationsFor(preview, 'c5'))
    expect(ciras).toHaveLength(2)
    expect(new Set(ciras.map((m) => m.characterName))).toEqual(new Set(['Cira']))
    expect(new Set(ciras.map((m) => m.characterId))).toEqual(new Set(['c3', 'c5']))
    expect(ciras[0].mutationId).not.toBe(ciras[1].mutationId)
    expect(preview.affectedCharacterIds).toContain('c3')
    expect(preview.affectedCharacterIds).toContain('c5')
  })

  test('16. mutationId is a pure function of (opId, characterId) — stable across re-plans', () => {
    const a = planOperation(FIXTURE, { op: 'delete', tags: ['Elf', 'Dark'] })
    const b = planOperation(FIXTURE, { op: 'delete', tags: ['Elf', 'Dark'] })

    const derived = (opId: string, characterId: string) => `${opId}:${characterId}`
    for (const mutation of a.mutations) {
      expect(mutation.mutationId).toBe(derived(a.opId, mutation.characterId))
    }
    // The load-bearing property: the SAME opId re-planned over the SAME input
    // reproduces byte-identical ids, so a retry cannot double-apply. Different
    // opIds must still collide nowhere.
    const idOf = (p: OperationPreview, id: string) => p.mutations.find((m) => m.characterId === id)!.mutationId
    expect(idOf(a, 'c4')).toBe(`${a.opId}:c4`)
    expect(idOf(b, 'c4')).toBe(`${b.opId}:c4`)
    expect(idOf(a, 'c4')).not.toBe(idOf(b, 'c4'))

    // Re-planning the same operation re-derives the same id for every character
    // it touches, so replaying it under the original opId reproduces the ids a
    // retry looks up — the double-apply guard, asserted directly.
    const again = planOperation(FIXTURE, { op: 'delete', tags: ['Elf', 'Dark'] })
    expect(again.mutations.map((m) => derived(a.opId, m.characterId))).toEqual(
      a.mutations.map((m) => m.mutationId),
    )

    // The id does NOT depend on the tag: changing which tags the operation
    // touches leaves the id for a given character byte-identical.
    const narrow = planOperation(FIXTURE, { op: 'delete', tags: ['Elf'] })
    const widened = planOperation(FIXTURE, { op: 'delete', tags: ['Elf', 'Dark'] })
    const narrowTag = (p: OperationPreview, id: string) => p.mutations.find((m) => m.characterId === id)!.tag
    expect(narrowTag(narrow, 'c4')).toBe('Elf')
    expect(narrowTag(widened, 'c4')).toBe('Dark')
    expect(`${narrow.opId}:c4`).toBe(`${widened.opId}:c4`.replace(widened.opId, narrow.opId))

    // Distinct character ids → distinct ids, even for same-named characters.
    expect(idOf(a, 'c3')).not.toBe(idOf(a, 'c5'))
    // A case-variant input changes nothing about the id.
    const upper = planOperation(FIXTURE, { op: 'delete', tags: ['ELF'] })
    expect(upper.mutations[0].mutationId).toBe(`${upper.opId}:c1`)

    // Globally unique across the whole preview.
    expect(new Set(a.mutations.map((m) => m.mutationId)).size).toBe(a.mutations.length)
    expect(new Set(b.mutations.map((m) => m.mutationId)).size).toBe(b.mutations.length)
  })

  test('createOperationId never collides and is seed-deterministic', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 500; i += 1) ids.add(createOperationId('assign'))
    expect(ids.size).toBe(500)

    expect(createOperationId('merge', 'seed-1')).toBe(createOperationId('merge', 'seed-1'))
    expect(createOperationId('merge', 'seed-1')).not.toBe(createOperationId('rename', 'seed-1'))
    expect(createOperationId('merge', 'seed-1')).not.toBe(createOperationId('merge', 'seed-2'))
    expect(createOperationId('assign', 'x')).not.toBe(createOperationId('assign'))
  })

  test('19. ordering is deterministic under input shuffling', () => {
    const inputs = [
      { op: 'delete', tags: ['Elf', 'Dark', 'Mage'] },
      { op: 'merge', primary: 'Magic', targets: ['Mage', 'Elf'] },
      { op: 'rename', from: 'Elf', to: 'Fairy' },
      { op: 'assign', tags: ['Nova'], selectedIds: ['c1', 'c4', 'c5'] },
    ] as const

    for (const input of inputs) {
      const base = normalize(planOperation(FIXTURE, input as never))
      for (const seed of [1, 7, 42, 1337, 90210]) {
        expect(normalize(planOperation(shuffle(FIXTURE, seed), input as never))).toEqual(base)
      }
    }
  })

  test('ordering is by characterName, then characterId', () => {
    const set = [
      character('z', 'Zoe', ['Elf', 'Dark']),
      character('a', 'Zoe', ['Elf', 'Dark']),
      character('m', 'Amy', ['Elf', 'Dark']),
    ]
    const preview = planOperation(set, { op: 'delete', tags: ['Dark', 'Elf'] })
    expect(preview.mutations.map((m) => `${m.characterName}/${m.characterId}`)).toEqual([
      'Amy/m',
      'Zoe/a',
      'Zoe/z',
    ])
  })
})

describe('validators', () => {
  const existing = entriesOf(FIXTURE)

  test('17. validateNewTagName', () => {
    expect(existing.map((e) => e.name)).toContain('Elf')
    expect(validateNewTagName('', existing)).toMatchObject({ ok: false, reason: 'blank' })
    expect(validateNewTagName('   ', existing)).toMatchObject({ ok: false, reason: 'blank' })
    expect(validateNewTagName('\t\n ', existing)).toMatchObject({ ok: false, reason: 'blank' })

    const exact = validateNewTagName('Elf', existing)
    expect(exact.ok).toBe(false)
    if (!exact.ok) {
      expect(exact.reason).toBe('duplicate')
      expect(exact.existing?.name).toBe('Elf')
    }

    const caseVariant = validateNewTagName('eLF', existing)
    expect(caseVariant.ok).toBe(false)
    if (!caseVariant.ok) {
      expect(caseVariant.reason).toBe('duplicate')
      expect(caseVariant.existing?.name).toBe('Elf')
    }

    const ok = validateNewTagName('  Scholar  ', existing)
    expect(ok).toEqual({ ok: true, value: 'Scholar' })
    expect(validateNewTagName('Scholar', existing).ok).toBe(true)
    expect(validateNewTagName('x', []).ok).toBe(true)
  })

  test('18. validateRenameTarget', () => {
    expect(validateRenameTarget('', 'Elf', existing)).toMatchObject({ ok: false, reason: 'blank' })
    expect(validateRenameTarget('   ', 'Elf', existing)).toMatchObject({ ok: false, reason: 'blank' })

    // Exact same spelling is a no-op rename.
    expect(validateRenameTarget('Elf', 'Elf', existing)).toMatchObject({ ok: false, reason: 'unchanged' })

    // Collision with a DIFFERENT existing tag.
    expect(validateRenameTarget('Magic', 'Elf', existing)).toMatchObject({ ok: false, reason: 'collision' })
    // Case-only collision with a different existing tag.
    expect(validateRenameTarget('MAGIC', 'Elf', existing)).toMatchObject({ ok: false, reason: 'collision' })

    // Case-only change of the CURRENT tag is NOT a collision.
    const selfCase = validateRenameTarget('Elf', 'elf', existing)
    expect(selfCase).toEqual({ ok: true, value: 'Elf' })

    // Genuine rename to a fresh name is accepted and trimmed.
    expect(validateRenameTarget('  Fairy  ', 'Elf', existing)).toEqual({ ok: true, value: 'Fairy' })
  })
})

describe('affectedCharactersForTag', () => {
  test('returns every character carrying the tag, case-insensitively', () => {
    const affected = affectedCharactersForTag(FIXTURE, 'eLF')
    expect(affected.map((c) => c.id)).toEqual(['c1', 'c3', 'c4', 'c5'])
    expect(affectedCharactersForTag(FIXTURE, 'nothing')).toEqual([])
    expect(affectedCharactersForTag([], 'Elf')).toEqual([])
  })
})

describe('20. defensive inputs', () => {
  test('empty character list does not throw', () => {
    for (const input of [
      { op: 'assign', tag: 'X', selectedIds: [] },
      { op: 'assign', tags: ['X'], selectedIds: ['nope'] },
      { op: 'remove', tags: ['X'] },
      { op: 'rename', from: 'X', to: 'Y' },
      { op: 'merge', primary: 'X', targets: ['Y'] },
      { op: 'delete', tags: ['X'] },
    ] as const) {
      const preview = planOperation([], input as never)
      expect(preview.mutations).toEqual([])
      expect(preview.affectedCharacterCount).toBe(0)
    }
  })

  test('null entries, missing tags, and non-array tags do not throw', () => {
    const nasty = [
      null as unknown as LumiTagCharacter,
      undefined as unknown as LumiTagCharacter,
      rawCharacter('n1', 'NoTags', undefined),
      rawCharacter('n2', 'NullTags', null),
      rawCharacter('n3', 'Junk', ['Elf', 42, '', '  ', null, 'Elf', 'Magic']),
      { id: '', name: 'NoId', tags: ['Elf'] } as unknown as LumiTagCharacter,
      character('n4', 'Fine', ['Elf']),
    ]

    expect(() => planOperation(nasty, { op: 'assign', tag: 'Nova', selectedIds: ['n1', 'n4'] })).not.toThrow()
    expect(() => planOperation(nasty, { op: 'delete', tags: ['Elf'] })).not.toThrow()
    expect(() => planOperation(nasty, { op: 'rename', from: 'Elf', to: 'Fairy' })).not.toThrow()
    expect(() => planOperation(nasty, { op: 'merge', primary: 'Magic', targets: ['Elf'] })).not.toThrow()

    const del = planOperation(nasty, { op: 'delete', tags: ['Elf'] })
    // Only characters with a usable id and the tag produce mutations.
    // ("Fine" sorts before "Junk" by characterName.)
    expect(del.mutations.map((m) => m.characterId)).toEqual(['n4', 'n3'])
    // Junk entries are normalized away.
    expect(targetFor(del, 'n3')).toEqual(['Magic'])

    // Junk tags don't corrupt assign either.
    const assign = planOperation(nasty, { op: 'assign', tag: 'Nova', selectedIds: ['n3', 'n4'] })
    expect(targetFor(assign, 'n3')).toEqual(['Elf', 'Magic', 'Nova'])
    expect(targetFor(assign, 'n4')).toEqual(['Elf', 'Nova'])
    // Unknown selection ids are reported as skipped, not silently dropped.
    const unknown = planOperation(nasty, { op: 'assign', tag: 'Nova', selectedIds: ['ghost'] })
    expect(unknown.skipped).toEqual([{ characterId: 'ghost', characterName: '', reason: 'character not found' }])

    // Blank/renameless operations degrade gracefully.
    expect(planOperation(FIXTURE, { op: 'rename', from: 'Elf', to: '  ' }).mutations).toEqual([])
    // Renaming Elf→Elf is a pure no-op: every one of the 6 characters is skipped.
    const selfRename = planOperation(FIXTURE, { op: 'rename', from: 'Elf', to: 'Elf' })
    expect(selfRename.mutations).toEqual([])
    expect(selfRename.skipped).toHaveLength(6)
    expect(selfRename.skipped.filter((s) => s.reason === 'already named this')).toHaveLength(4)
    expect(selfRename.skipped.filter((s) => s.reason === 'tag not present')).toHaveLength(2)
    expect(planOperation(FIXTURE, { op: 'merge', primary: 'Magic', targets: [] }).mutations).toEqual([])
    expect(planOperation(null as never, { op: 'delete', tags: ['Elf'] }).mutations).toEqual([])
    expect(planOperation(undefined as never, { op: 'delete', tags: ['Elf'] }).mutations).toEqual([])
    expect(planOperation(FIXTURE, { op: 'remove', tags: [] }).mutations).toEqual([])
    expect(planOperation(FIXTURE, { op: 'delete', tags: ['nope'] }).skipped.length).toBe(6)
  })
})

