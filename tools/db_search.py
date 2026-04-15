from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional


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


def _as_hits(res: Dict[str, Any]) -> List[Dict[str, Any]]:
    ids = (res.get("ids") or [[]])[0]
    docs = (res.get("documents") or [[]])[0]
    metas = (res.get("metadatas") or [[]])[0]
    dists = (res.get("distances") or [[]])[0]

    hits: List[Dict[str, Any]] = []
    for i in range(len(ids)):
        m = metas[i] or {}
        hits.append(
            {
                "id": ids[i],
                "distance": dists[i] if i < len(dists) else None,
                "work": m.get("work"),
                "chapter_num": m.get("chapter_num"),
                "chapter_title": m.get("chapter_title"),
                "para_start": m.get("para_start"),
                "para_end": m.get("para_end"),
                "chunk_index": m.get("chunk_index"),
                "chunk_count": m.get("chunk_count"),
                "source_epub": m.get("source_epub"),
                "source_href": m.get("source_href"),
                "text": docs[i],
            }
        )
    return hits


def search(*, work: str, db_dir: str, embed_model: str, query: Optional[str], chapter: Optional[int], k: int) -> Dict[str, Any]:
    import chromadb

    client = chromadb.PersistentClient(path=db_dir)
    col = _get_collection(client, work, embed_model)

    where = {}
    if chapter is not None:
        where["chapter_num"] = chapter

    if query:
        res = col.query(query_texts=[query], n_results=k, where=where or None, include=["metadatas", "documents", "distances"])
        return {"ok": True, "mode": "semantic", "hits": _as_hits(res)}

    # No query: just browse within a chapter (or error if no chapter).
    if chapter is None:
        return {"ok": False, "error": "Provide --query or --chapter."}

    res = col.get(where=where, include=["metadatas", "documents"])
    ids = res.get("ids") or []
    docs = res.get("documents") or []
    metas = res.get("metadatas") or []

    combined: List[Dict[str, Any]] = []
    for i in range(len(ids)):
        m = metas[i] or {}
        combined.append(
            {
                "id": ids[i],
                "distance": None,
                "work": m.get("work"),
                "chapter_num": m.get("chapter_num"),
                "chapter_title": m.get("chapter_title"),
                "para_start": m.get("para_start"),
                "para_end": m.get("para_end"),
                "chunk_index": m.get("chunk_index"),
                "chunk_count": m.get("chunk_count"),
                "source_epub": m.get("source_epub"),
                "source_href": m.get("source_href"),
                "text": docs[i] if i < len(docs) else "",
            }
        )

    combined.sort(key=lambda x: (int(x.get("chunk_index") or 0), x.get("id") or ""))
    if k and k > 0:
        combined = combined[:k]
    return {"ok": True, "mode": "browse", "hits": combined}


def main() -> int:
    ap = argparse.ArgumentParser(description="Search Writer Orchestrator ChromaDB canon store")
    ap.add_argument("--work", required=True, help="Work id (shadow_slave, lotm, etc.)")
    ap.add_argument("--db-dir", default=None, help="Chroma persistence dir")
    ap.add_argument("--embed-model", default="all-MiniLM-L6-v2", help="SentenceTransformer model name")
    ap.add_argument("--query", default=None, help="Search query (semantic)")
    ap.add_argument("--chapter", type=int, default=None, help="Filter to a chapter number")
    ap.add_argument("--k", type=int, default=8, help="Max results")
    ap.add_argument("--json", action="store_true", help="Output JSON only")
    args = ap.parse_args()

    db_dir = _resolve_db_dir(args.db_dir)
    try:
        res = search(
            work=args.work,
            db_dir=db_dir,
            embed_model=args.embed_model,
            query=args.query,
            chapter=args.chapter,
            k=args.k,
        )
        if args.json:
            print(json.dumps(res, ensure_ascii=True))
        else:
            if not res.get("ok"):
                print(f"ERROR: {res.get('error')}", file=sys.stderr)
                return 2
            hits = res.get("hits") or []
            for h in hits:
                ch = h.get("chapter_num")
                title = h.get("chapter_title") or ""
                para = f"p{h.get('para_start')}-{h.get('para_end')}"
                print(f"[ch {ch}] {para} {title}".strip())
                print(h.get("text", "").strip())
                print("---")
        return 0
    except Exception as e:
        if args.json:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=True))
        else:
            print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
