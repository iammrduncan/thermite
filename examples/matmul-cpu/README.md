# matmul-cpu: a sample project and its kit

A small C matrix multiply for a first agent campaign on a CPU rig. Its kernel is slow on purpose, so an agent has speed to find, and the kit's check catches a wrong answer.

| Folder | What it holds |
| --- | --- |
| `project/` | The project the agents change. `src/kernel/matmul.c` is the kernel, `src/ref/matmul_ref.c` a reference it must not call. |
| `kit/` | The kit: how the judge builds, runs and checks the project. `kit.json`, the benchmark in `bench/`, and the check, `check.mjs`. Its cases are `small`, `large` and `held`; its score is `flops_per_s`, higher is better. |

The kit is outside the project folder, so the agents never see it.

## Start a campaign on it

The tutorial [Run your first campaign](../../docs/_site/src/content/docs/tutorials/agents-with-a-free-model.md) does this step by step. In short:

1. Pack the kit, in a clone of Thermite at the release you run (`git clone --branch v0.1.0 …`):

   ```sh
   tar -czf matmul-cpu-kit.tar.gz -C examples/matmul-cpu kit
   ```

2. On the dashboard's **New campaign** page, under **3 Project**, give this repository's address, `https://github.com/iammrduncan/thermite.git`, start from the same release (**Start from**: `v0.1.0`), and set **Folder in the repository** to `examples/matmul-cpu/project`. The files the agents may change are `src/kernel/**`. Under **Advanced**, the **Lines never allowed** are `__real_`, `__wrap_` and `thermite_ref_calls`: a change that adds one could hide a call to the reference from the kit's check.
3. Under **4 How to measure**, choose **Upload a kit** and upload `matmul-cpu-kit.tar.gz`. Measure `small` and `large`, and keep `held` as a hidden test.

The rig fetches the whole repository, and the run starts from the project folder: the agents get only its files.

The same project and kit, with known good and bad changes, are the rig's smoke check: `examples/smoke-project` and `kits/smoke-cpu`.
