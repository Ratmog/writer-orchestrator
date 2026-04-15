# Writer Orchestrator Tools

Local-first canon database utilities.

## Install (recommended: venv)

```bash
cd writer-orchestrator
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
pip install -r tools/requirements.txt
```

## Ingest an EPUB into ChromaDB

Creates paragraph-aware chunks and stores them in a persistent ChromaDB directory.

```bash
cd writer-orchestrator
source .venv/bin/activate
python tools/ingest_epub.py \
  --epub "/path/to/Shadow Slave.epub" \
  --work shadow_slave \
  --db-dir ".writer_orchestrator/chroma"
```

## Search

```bash
cd writer-orchestrator
source .venv/bin/activate
python tools/db_search.py --work shadow_slave --query "what happens when Mordret appears?" --k 6
python tools/db_search.py --work shadow_slave --chapter 400 --k 12
```

Notes:
- No model APIs required. Embeddings are computed locally via `sentence-transformers`.
- If you want a different embedding model, set `--embed-model`.

