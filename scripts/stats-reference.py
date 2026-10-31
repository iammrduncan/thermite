# Generates tests/helpers/data/stats-reference.json, the offline reference values the TypeScript
# statistics are tested against. Run: uvx --with scipy --with numpy python -I scripts/stats-reference.py

import json
from scipy import stats
import numpy as np
out = {"t_quantile": [], "t_cdf": [], "mean_interval": []}
for p in [0.9, 0.95, 0.975, 0.98333333333, 0.99, 0.995, 0.999]:
    for df in [1, 2, 3, 4, 5, 8, 10, 30, 100]:
        out["t_quantile"].append([p, df, float(stats.t.ppf(p, df))])
for t in [-3.5, -1.0, 0.0, 0.4, 1.7, 2.5, 6.0]:
    for df in [1, 3, 7, 25]:
        out["t_cdf"].append([t, df, float(stats.t.cdf(t, df))])
rng = np.random.default_rng(7)
for n, alpha in [(3, 0.1/3), (6, 0.1/3), (9, 0.1/3), (5, 0.05), (12, 0.05)]:
    xs = rng.normal(0.01, 0.004, n)
    m = xs.mean(); se = xs.std(ddof=1)/np.sqrt(n)
    q = stats.t.ppf(1 - alpha/2, n-1)
    out["mean_interval"].append({"xs": [float(x) for x in xs], "alpha": alpha, "mean": float(m), "low": float(m - q*se), "high": float(m + q*se)})
out = {"generated_by": "scripts/stats-reference.py (scipy, numpy; seed 7)", **out}
print(json.dumps(out, separators=(",", ":")))
