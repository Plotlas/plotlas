"""Layout plugins: the ``LayoutPlugin`` ABC (``base``) and the Phase-1 concrete
layouts (``grid``, ``datetime_layout``, ``categorical``, ``scatter`` — the
latter registered in ``worker._PLUGINS`` like the rest; D-26). Phase-2 ``umap``
and ``network`` layouts share the same contract. ``categorical`` and
``scatter`` are multi-entry families: the worker invokes ``compute()`` once per
role entry with ``config={"entry_index": i}``.
"""
