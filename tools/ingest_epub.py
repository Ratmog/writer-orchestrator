from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys
from dataclasses import asdict
from typing import Dict, List, Optional, Tuple

from bs4 import BeautifulSoup
from ebooklib import epub

from chunking import chunk_paragraphs


def _extract_text_paragraphs(html: str) -> List[str]:
    soup = BeautifulSoup(html, "lxml")

    # Remove noise.
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    paras: List[str] = []
    for p in soup.find_all(["p", "h1", "h2", "h3", "li"]):
        t = p.get_text(" ", strip=True)
        t = " ".join(t.split())
        if t:
            paras.append(t)
    return paras


def _flatten_toc(toc) -> List[Tuple[str, str]]:
    """
    Returns list of (title, href).
    """

    flat: List[Tuple[str, str]] = []

    def walk(node):
        if isinstance(node, (list, tuple)):
            for x in node:
                walk(x)
            return
        # ebooklib uses epub.Link or epub.Section
        if hasattr(node, "href") and hasattr(node, "title"):
            href = getattr(node, "href", "") or ""
            title = getattr(node, "title", "") or ""
            if href:
                flat.append((title, href))
            return
        if hasattr(node, "subitems"):
            walk(getattr(node, "subitems", []))

    walk(toc)
    # Dedup by href while preserving order.
    seen = set()
    out: List[Tuple[str, str]] = []
    for title, href in flat:
        href = href.split("#")[0]
        if not href or href in seen:
            continue
        seen.add(href)
        out.append((title, href))
    return out


def _infer_chapter_num(title: str) -> Optional[int]:
    m = re.search(r"\bchapter\s+(\d+)\b", title or "", flags=re.IGNORECASE)
    if m:
        try:
            return int(m.group(1))
        except Exception:
            return None
    m = re.search(r"\b(\d{1,5})\b", title or "")
    if m:
        try:
            return int(m.group(1))
        except Exception:
            return None
    return None


def _ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _resolve_db_dir(db_dir: Optional[str]) -> str:
    if db_dir:
        return db_dir
    env = os.environ.get("WRITER_ORCH_DB_DIR")
    if env:
        return env
    return os.path.join(".writer_orchestrator", "chroma")


def _get_collection(client, work: str, embed_model: str):
    # Local embeddings (downloads model on first run).
    from chromadb.utils import embedding_functions

    embed_fn = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=embed_model)
    return client.get_or_create_collection(
        name=f"canon_{work}",
        metadata={"work": work, "embed_model": embed_model},
        embedding_function=embed_fn,
    )


def ingest_epub(*, epub_path: str, work: str, db_dir: str, embed_model: str) -> Dict:
    book = epub.read_epub(epub_path)
    toc = _flatten_toc(book.toc)

    # Build map from href -> document item.
    items_by_name: Dict[str, epub.EpubItem] = {}
    for item in book.get_items():
        if item.get_type() == epub.ITEM_DOCUMENT:
            items_by_name[item.get_name()] = item

    client = None
    try:
        import chromadb

        _ensure_dir(db_dir)
        client = chromadb.PersistentClient(path=db_dir)
        collection = _get_collection(client, work, embed_model)
    except Exception as e:
        raise RuntimeError(
            f"Failed to initialize ChromaDB. Install deps and try again. Root error: {e}"
        ) from e

    now = dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).isoformat()
    epub_abs = os.path.abspath(epub_path)

    added = 0
    chapters = 0

    # If no TOC, fallback to all documents.
    chapter_items: List[Tuple[str, str]] = toc if toc else [(i.get_name(), i.get_name()) for i in items_by_name.values()]

    for idx, (title, href) in enumerate(chapter_items, start=1):
        item = items_by_name.get(href)
        if not item:
            continue

        try:
            html = item.get_content().decode("utf-8", errors="ignore")
        except Exception:
            html = item.get_content().decode(errors="ignore")

        paragraphs = _extract_text_paragraphs(html)
        if not paragraphs:
            continue

        chap_num = _infer_chapter_num(title) or idx
        chunks = chunk_paragraphs(paragraphs)
        if not chunks:
            continue

        ids: List[str] = []
        docs: List[str] = []
        metas: List[Dict] = []

        for c_idx, c in enumerate(chunks):
            chunk_id = f"{work}:ch{chap_num}:chunk{c_idx}"
            ids.append(chunk_id)
            docs.append(c.text)
            metas.append(
                {
                    "work": work,
                    "chapter_num": chap_num,
                    "chapter_title": title or "",
                    "source_epub": epub_abs,
                    "source_href": href,
                    "chunk_index": c_idx,
                    "chunk_count": len(chunks),
                    "para_start": c.para_start,
                    "para_end": c.para_end,
                    "ingested_at": now,
                }
            )

        collection.upsert(ids=ids, documents=docs, metadatas=metas)
        added += len(chunks)
        chapters += 1

    return {"work": work, "db_dir": os.path.abspath(db_dir), "chapters": chapters, "chunks": added}


def main() -> int:
    ap = argparse.ArgumentParser(description="Ingest EPUB into Writer Orchestrator ChromaDB")
    ap.add_argument("--epub", required=True, help="Path to an .epub file")
    ap.add_argument("--work", required=True, help="Work id, e.g. shadow_slave, lotm")
    ap.add_argument("--db-dir", default=None, help="Chroma persistence dir (default: .writer_orchestrator/chroma)")
    ap.add_argument("--embed-model", default="all-MiniLM-L6-v2", help="SentenceTransformer model name")
    args = ap.parse_args()

    db_dir = _resolve_db_dir(args.db_dir)
    try:
        res = ingest_epub(epub_path=args.epub, work=args.work, db_dir=db_dir, embed_model=args.embed_model)
        print(res)
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

