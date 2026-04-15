from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Sequence


@dataclass(frozen=True)
class Chunk:
    text: str
    para_start: int
    para_end: int


def _word_count(s: str) -> int:
    return len([w for w in s.split() if w])


def chunk_paragraphs(
    paragraphs: Sequence[str],
    *,
    target_words: int = 380,
    overlap_words: int = 80,
    max_words: int = 520,
) -> List[Chunk]:
    """
    Paragraph-aware chunking using word-count as a token proxy.

    - target_words: aim around ~500 tokens (roughly 350-400 words).
    - overlap_words: overlap to preserve continuity.
    - max_words: hard cap to avoid giant chunks if a paragraph is huge.
    """

    # Normalize, drop empty paragraphs.
    paras: List[str] = []
    for p in paragraphs:
        p = " ".join((p or "").strip().split())
        if p:
            paras.append(p)

    chunks: List[Chunk] = []
    i = 0
    while i < len(paras):
        start = i
        buf: List[str] = []
        words = 0

        while i < len(paras):
            p = paras[i]
            p_words = _word_count(p)

            # If the next paragraph alone is huge, split it hard.
            if not buf and p_words > max_words:
                chunks.append(Chunk(text=p, para_start=i, para_end=i))
                i += 1
                start = i
                buf = []
                words = 0
                continue

            # Stop if we'd overshoot too far past target.
            if buf and words + p_words > max_words:
                break

            buf.append(p)
            words += p_words
            i += 1

            if words >= target_words:
                break

        end = i - 1
        if buf:
            chunks.append(Chunk(text="\n\n".join(buf), para_start=start, para_end=end))

        # Overlap: move i back by enough paragraphs to reach overlap_words.
        if i >= len(paras):
            break

        back_words = 0
        back = i
        while back > start and back_words < overlap_words:
            back -= 1
            back_words += _word_count(paras[back])
        i = back

        # Ensure progress even on weird inputs.
        if i <= start:
            i = start + 1

    return chunks

