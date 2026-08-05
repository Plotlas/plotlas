"""image-viz ingestion pipeline.

Top-level importable package (decision D-15: the API enqueues
``"pipeline.worker.run_ingest_job"`` by dotted-path string). Writes the
``/datasets/{ds_id}/`` tree; never imports the ``api`` package.
"""
