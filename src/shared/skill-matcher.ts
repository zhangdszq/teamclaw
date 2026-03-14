export type SkillMatchCandidate = {
  name: string;
  label?: string;
  description?: string;
  triggers?: string[];
};

const MIN_MATCH_SCORE = 2;
const MIN_UNAMBIGUOUS_TIE_SCORE = 4;

function tokenizeSkillText(text: string): string[] {
  return [...new Set(text
    .toLowerCase()
    .split(/[\s,，。.!?！？、:：;；/()（）[\]【】'"“”`+-]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1))];
}

export function extractTriggerPhrases(text: string): string[] {
  const patterns = [
    /"([^"\n]{2,})"/g,
    /'([^'\n]{2,})'/g,
    /“([^”\n]{2,})”/g,
    /‘([^’\n]{2,})’/g,
    /「([^」\n]{2,})」/g,
    /『([^』\n]{2,})』/g,
  ];
  const phrases = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const phrase = match[1]?.trim().toLowerCase();
      if (phrase) phrases.add(phrase);
    }
  }
  return [...phrases];
}

export function chineseBigrams(text: string): Set<string> {
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, "");
  const grams = new Set<string>();
  for (let idx = 0; idx < cjk.length - 1; idx++) {
    grams.add(cjk.slice(idx, idx + 2));
  }
  return grams;
}

function getBigramOverlapScore(prompt: string, skill: SkillMatchCandidate): number {
  const promptBigrams = chineseBigrams(prompt);
  if (promptBigrams.size === 0) return 0;

  const skillText = [skill.label ?? "", skill.description ?? "", ...(skill.triggers ?? [])]
    .filter(Boolean)
    .join(" ");
  const skillBigrams = chineseBigrams(skillText);
  if (skillBigrams.size === 0) return 0;

  let overlap = 0;
  for (const bigram of promptBigrams) {
    if (skillBigrams.has(bigram)) overlap += 1;
  }

  return Math.min(overlap, 5);
}

function getNameTokenScore(prompt: string, skillName: string): number {
  const lowerPrompt = prompt.toLowerCase();
  const tokens = skillName.toLowerCase().split(/[-_]+/).filter((t) => t.length >= 2);
  let bonus = 0;
  for (const token of tokens) {
    if (lowerPrompt.includes(token)) {
      bonus += /^[a-z0-9]+$/.test(token) && token.length >= 4 ? 2 : 1;
    }
  }
  return bonus;
}

function scoreSkillMatch(prompt: string, skill: SkillMatchCandidate): number {
  const lowerPrompt = prompt.toLowerCase();
  let score = 0;

  if (lowerPrompt.includes(skill.name.toLowerCase())) score += 5;

  score += getNameTokenScore(lowerPrompt, skill.name);

  const label = skill.label?.trim();
  if (label && lowerPrompt.includes(label.toLowerCase())) score += 6;

  const triggerPhrases = [...new Set([
    ...(skill.triggers ?? []).map((trigger) => trigger.trim().toLowerCase()).filter(Boolean),
    ...extractTriggerPhrases(skill.description ?? ""),
  ])];
  for (const trigger of triggerPhrases) {
    if (lowerPrompt.includes(trigger)) score += 3;
  }

  const skillFullText = [skill.name, label ?? "", skill.description ?? "", ...(skill.triggers ?? [])]
    .filter(Boolean).join(" ").toLowerCase();

  const skillKeywords = tokenizeSkillText(skillFullText);
  for (const keyword of skillKeywords) {
    if (keyword.length < 2 || !lowerPrompt.includes(keyword)) continue;
    const isAsciiKeyword = /^[a-z0-9_-]+$/.test(keyword);
    score += isAsciiKeyword && keyword.length >= 4 ? 2 : 1;
  }

  const promptKeywords = tokenizeSkillText(lowerPrompt);
  for (const token of promptKeywords) {
    if (token.length < 2 || skillKeywords.includes(token)) continue;
    if (skillFullText.includes(token)) {
      score += 1;
    } else {
      const cjk = token.replace(/[^\u4e00-\u9fff]/g, "");
      for (let i = 0; i <= cjk.length - 2; i++) {
        if (skillFullText.includes(cjk.slice(i, i + 2))) { score += 1; break; }
      }
    }
  }

  score += getBigramOverlapScore(lowerPrompt, skill);

  return score;
}

export function findBestSkillMatch<T extends SkillMatchCandidate>(
  prompt: string,
  availableSkills: T[],
): T | null {
  if (availableSkills.length === 0) return null;

  const scored = availableSkills.map((skill) => ({
    skill,
    score: scoreSkillMatch(prompt, skill),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.skill.name.length !== b.skill.name.length) return a.skill.name.length - b.skill.name.length;
    return a.skill.name.localeCompare(b.skill.name, "en");
  });

  const best = scored[0];
  if (!best || best.score < MIN_MATCH_SCORE) return null;

  const secondBestScore = scored.length > 1 ? scored[1].score : 0;
  if (best.score === secondBestScore && best.score < MIN_UNAMBIGUOUS_TIE_SCORE) return null;

  return best.skill;
}
