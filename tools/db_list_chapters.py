from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple


def _resolve_db_dir(db_dir: Optional[str]) -> str:
    if db_dir:
        return db_dir
    env = os.environ.get("WRITER_ORCH_DB_DIR")
    if env:
        return env
    return os.path.join(".writer_orchestrator", "chroma")


def _get_collection(client, work: str, embed_model: str):
    from chromadb.utils import embedding_functions

    embed_fn = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=embed_model)
    return client.get_or_create_collection(
        name=f"canon_{work}",
        metadata={"work": work, "embed_model": embed_model},
        embedding_function=embed_fn,
    )


def list_chapters(*, work: str, db_dir: str, embed_model: str) -> Dict[str, Any]:
    import chromadb

    client = chromadb.PersistentClient(path=db_dir)
    col = _get_collection(client, work, embed_model)

    # Pull just metadatas; could be large, but still practical for personal use.
    res = col.get(include=["metadatas"])
    metas = res.get("metadatas") or []

    best_title: Dict[int, str] = {}
    max_chunk: Dict[int, int] = {}

    for m in metas:
        if not m:
            continue
        ch = m.get("chapter_num")
        if ch is None:
            continue
        try:
            ch_i = int(ch)
        except Exception:
            continue
        title = (m.get("chapter_title") or "").strip()
        idx = m.get("chunk_index")
        try:
            idx_i = int(idx) if idx is not None else 0
        except Exception:
            idx_i = 0

        if title and ch_i not in best_title:
            best_title[ch_i] = title
        prev = max_chunk.get(ch_i, -1)
        if idx_i > prev:
            max_chunk[ch_i] = idx_i

    chapters: List[Dict[str, Any]] = []
    for ch in sorted(set(list(best_title.keys()) + list(max_chunk.keys()))):
        chapters.append(
            {
                "chapter_num": ch,
                "chapter_title": best_title.get(ch, ""),
                "chunk_max_index": max_chunk.get(ch, 0),
            }
        )

    return {"ok": True, "work": work, "chapters": chapters}


def main() -> int:
    ap = argparse.ArgumentParser(description="List chapter numbers available in ChromaDB store")
    ap.add_argument("--work", required=True, help="Work id")
    ap.add_argument("--db-dir", default=None, help="Chroma persistence dir")
    ap.add_argument("--embed-model", default="all-MiniLM-L6-v2", help="SentenceTransformer model")
    ap.add_argument("--json", action="store_true", help="Output JSON only")
    args = ap.parse_args()

    db_dir = _resolve_db_dir(args.db_dir)
    try:
        res = list_chapters(work=args.work, db_dir=db_dir, embed_model=args.embed_model)
        if args.json:
            print(json.dumps(res, ensure_ascii=True))
        else:
            for c in res.get("chapters", []):
                num = c.get("chapter_num")
                title = c.get("chapter_title") or ""
                print(f"{num}\t{title}".strip())
        return 0
    except Exception as e:
        if args.json:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=True))
        else:
            print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

