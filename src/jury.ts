import type {
  ModelRef,
  PanelConfidence,
  PanelVote,
  PanelVoteChoice,
} from "./types.ts";

const VOTE = /\bVOTE:\s*(approve|reject|abstain|conditional)\b/i;
const CONFIDENCE = /\bCONFIDENCE:\s*(high|medium|low)\b/i;
const POSITION =
  /\bPOSITION:\s*(.+?)(?=\n\s*(?:VOTE|CONFIDENCE|RATIONALE|RISKS|ALTERNATIVE):|\n\n|$)/is;
const RATIONALE =
  /\bRATIONALE:\s*([\s\S]+?)(?=\n\s*(?:RISKS|ALTERNATIVE|VOTE|CONFIDENCE|POSITION):|$)/i;
const RISKS =
  /\bRISKS:\s*([\s\S]+?)(?=\n\s*(?:ALTERNATIVE|VOTE|CONFIDENCE|POSITION|RATIONALE):|$)/i;
const ALTERNATIVE =
  /\bALTERNATIVE:\s*([\s\S]+?)(?=\n\s*(?:VOTE|CONFIDENCE|POSITION|RATIONALE|RISKS):|$)/i;

export function parsePanelVote(
  memberID: string,
  model: ModelRef,
  raw: string,
): PanelVote {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !/^(vote|confidence|position|rationale|risks|alternative):/i.test(line),
    );
  return {
    memberID,
    model,
    raw,
    position: (raw.match(POSITION)?.[1] ?? firstLine ?? "")
      .trim()
      .slice(0, 500),
    vote:
      (raw.match(VOTE)?.[1]?.toLowerCase() as PanelVoteChoice | undefined) ??
      "unknown",
    confidence:
      (raw.match(CONFIDENCE)?.[1]?.toLowerCase() as
        | PanelConfidence
        | undefined) ?? "unknown",
    rationale: (raw.match(RATIONALE)?.[1] ?? "").trim().slice(0, 1500),
    risks: (raw.match(RISKS)?.[1] ?? "").trim().slice(0, 800),
    alternative: (raw.match(ALTERNATIVE)?.[1] ?? "").trim().slice(0, 500),
  };
}

export function tallyMajority(
  votes: PanelVote[],
): PanelVoteChoice | "split" | "none" {
  const counts = new Map<PanelVoteChoice, number>();
  votes
    .filter((vote) => vote.vote !== "unknown" && vote.vote !== "abstain")
    .forEach((vote) => counts.set(vote.vote, (counts.get(vote.vote) ?? 0) + 1));
  const ranked = [...counts.entries()].sort(
    (left, right) => right[1] - left[1],
  );
  if (ranked.length === 0) return "none";
  if (ranked[0]?.[1] === ranked[1]?.[1]) return "split";
  return ranked[0]![0];
}

export function formatBallots(votes: PanelVote[]) {
  return votes
    .map((vote) =>
      [
        `### Juror ${vote.memberID} (${vote.model.providerID}/${vote.model.modelID})`,
        `VOTE: ${vote.vote}`,
        `CONFIDENCE: ${vote.confidence}`,
        `POSITION: ${vote.position}`,
        vote.rationale ? `RATIONALE:\n${vote.rationale}` : "",
        vote.risks ? `RISKS:\n${vote.risks}` : "",
        vote.alternative ? `ALTERNATIVE:\n${vote.alternative}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}
