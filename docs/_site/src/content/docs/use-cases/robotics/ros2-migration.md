---
title: "ROS 1 to ROS 2 migration"
description: "Use a Thermite goal campaign to move a robot's software stack from ROS 1 Noetic to ROS 2, subsystem by subsystem, with each goal checked by a kit the agents can't edit: colcon builds, unit and launch tests, missions in Gazebo and topic rates."
type: use-case
useCase:
  mode: goal
  personas: [startups, enterprises]
  summary: "Agents port the robot's packages to ROS 2. The judge builds them with colcon, runs the tests and launch tests, and drives missions in Gazebo; the run ends when every goal passes twice."
  measure: "Goals met, subsystem by subsystem · tests, missions and topic rates hold · Gazebo worlds the agents never see"
sidebar:
  order: 2
---

ROS 1 Noetic, the last ROS 1 release, reached end of life on 31 May 2025: the ROS team no longer provides security updates, bug fixes or updated binaries for it. The current long-term ROS 2 releases are Jazzy Jalisco, supported to May 2029 on Ubuntu 24.04, and Lyrical Luth, released in May 2026 and supported to May 2031. The simulator moves too. Noetic's was Gazebo Classic (Gazebo 11), which reached end of life in January 2025; Gazebo's documentation pairs Jazzy with Gazebo Harmonic and Lyrical with Gazebo Jetty, releases of the new Gazebo, once called Ignition.

Teams port package by package, following ROS 2's migration guides: `package.xml` to format 2, catkin to ament, `roscpp` and `rospy` to `rclcpp` and `rclpy`, XML launch files to ROS 2 launch files, rostest to launch_testing, and a global parameter server to parameters that "are associated per node". Larger dependencies move to their ROS 2 successors: move_base to Nav2, MoveIt to MoveIt 2, Gazebo Classic's plugins to Gazebo systems, with ros_gz between Gazebo and ROS 2. The tool for moving one package at a time, ros1_bridge, needs ROS 1 and ROS 2 on one system, and its README says Ubuntu 24.04 "does not support ROS 1". Done means each package builds with colcon, its tests pass, the robot completes its missions in simulation and its topics keep their rates. Thermite runs the move as a goal campaign, with goals for each subsystem.

## Where Thermite fits

The agents change the stack's packages, tests included, each lane in its own copy. The judge builds each change with `colcon build` against the ROS 2 in the rig's image, runs each subsystem's tests with `colcon test`, runs the kit's own launch tests, and drives the robot through its missions in Gazebo, recording its topics. The kit spawns its own model of the robot in its own worlds. The agents never see the kit, its worlds, its recordings of the ROS 1 stack or the worlds held back for the final checks.

## Example campaigns

### 1. A warehouse robot from Noetic to Jazzy

A company's warehouse robots run Noetic: drivers for the lidar, IMU and wheel encoders, AMCL and an EKF for localization, move_base, and a mission node that takes jobs in custom messages. It must ship on ROS 2 Jazzy.

- **Mode:** a goal campaign. It ends when every required goal passes on two checks of the best version, hidden worlds included, or, as this contract allows, when three different approaches have each been tried and failed.
- **The goals:**
  - every package builds with colcon against Jazzy, and no `package.xml` names a ROS 1 package;
  - the fleet messages, services and actions keep their ROS 1 fields;
  - each subsystem's tests pass, drivers, localization and the mission node, with no fewer passing than on ROS 1. These require the build, so they run only once it passes;
  - the kit's launch tests pass: each subsystem's launch file starts its nodes, which load their parameters and publish on their topics;
  - the robot completes every mission in two Gazebo worlds without touching anything, and in two worlds held back for confirmation;
  - topics such as `/scan`, `/odom` and `/tf` keep their ROS 1 rates, on the simulation's clock, and missions take no longer than on ROS 1, plus a margin;
  - optionally, for a review panel of models: parameters are declared on the nodes that use them.
- **What the agents change:** every package in `src/`: `package.xml`, `CMakeLists.txt` or `setup.py`, the nodes, launch files, parameter files and tests.
- **What agents would try:** the guides' order, packages, interfaces, nodes, then launch files and parameters; the conversion tools the guides list, then fixing what they leave; Nav2 in place of move_base, with parameters carried over; rostest tests rewritten as launch tests.
- **What you get:** a migrated branch and, for each goal, the judge's evidence: test counts, launch test results, each mission's outcome and each topic's rate.

### 2. Faster missions on Nav2

Once the stack runs on Jazzy, the team wants its missions faster, with no contact.

- **Mode:** a hill climb.
- **What the agents change:** Nav2's parameter files and behaviour tree in `src/amr_navigation/`.
- **The number:** mean mission time in the kit's worlds, on the simulation's clock. Lower is better.
- **What must hold:** any contact fails the check; the closest approach to a shelf and the topics' rates are guards.
- **Hidden from the agents:** a world with narrower aisles and people walking, as Gazebo actors.
- **What agents would try:** another controller plugin, such as Regulated Pure Pursuit or MPPI; the costmaps' inflation; the velocity smoother's limits; the recoveries in the behaviour tree.

### 3. Read the porting notes first

Before either, a research campaign can answer "For each third-party package our stack depends on, is there a ROS 2 Jazzy release, and if not, what replaced it?" from migration guides, release notes and issue threads, with each claim's quotes found by code, word for word, in the pages it archived.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "noetic-to-jazzy",
  "version": 1,
  "title": "Move the warehouse robot's stack from ROS 1 Noetic to ROS 2 Jazzy",
  "mode": "goal",
  "project": {
    "repo": "amr-stack",
    "kit": { "repo": "amr-migration-kit", "commit": "8e3b1d6f0a9c4e7b2d5f8a1c3e6b9d0f2a4c7e1b" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["src/**"],
  "goals": [
    { "id": "builds", "description": "every package builds with colcon against Jazzy, and no package.xml names a ROS 1 package", "verify": { "type": "code", "verifier": "builds" } },
    { "id": "interfaces", "description": "the fleet messages, services and actions build with their ROS 1 fields", "verify": { "type": "code", "verifier": "interfaces" } },
    { "id": "driver-tests", "description": "the drivers' tests pass, no fewer than on ROS 1", "verify": { "type": "code", "verifier": "driver-tests" } },
    { "id": "localization-tests", "description": "the localization tests pass, no fewer than on ROS 1", "verify": { "type": "code", "verifier": "localization-tests" } },
    { "id": "mission-tests", "description": "the mission node's tests pass, no fewer than on ROS 1", "verify": { "type": "code", "verifier": "mission-tests" } },
    { "id": "launch-tests", "description": "the kit's launch tests pass for every subsystem", "verify": { "type": "code", "verifier": "launch-tests" } },
    { "id": "missions", "description": "the robot completes every mission in each world without a contact", "verify": { "type": "code", "verifier": "missions" } },
    { "id": "rates", "description": "each listed topic keeps its ROS 1 rate within 5%, on the simulation's clock", "verify": { "type": "code", "verifier": "rates" } },
    { "id": "mission-time", "description": "warehouse A's missions take at most 412.5 s of simulated time, 10% above ROS 1's 375 s", "verify": { "type": "metric_threshold", "metric": "mission_s", "op": "<=", "value": 412.5, "cells": ["warehouse-a"] } },
    { "id": "idiomatic", "description": "the code reads as ROS 2 code", "required": false, "verify": { "type": "review", "criteria": ["parameters declared on the nodes that use them", "no ROS 1 compatibility layer left"] } }
  ],
  "deliverable": "a branch whose stack meets every required goal on ROS 2 Jazzy with Gazebo Harmonic",
  "insufficient": ["running part of the stack on ROS 1 behind ros1_bridge", "skipping, disabling or deleting tests", "waypoints or maps written for the worlds the agents can see"],
  "adversarial_checklist": ["calls to the simulator's services that move a model", "writes to the run's recordings or outputs", "a topic republished at its rate with stale data", "tests built with BUILD_TESTING off or marked to skip"],
  "infeasibility": { "allowed": true, "min_refuted_approaches": 3 },
  "held_out_cells": ["hidden-aisles", "hidden-dock"]
}
```

The kit holds the robot's simulation model, the worlds in SDF, the launch tests, each package's count of passing tests on ROS 1, and each topic's rate and mission's time on ROS 1 in the same worlds. It builds with `colcon build`, without `--symlink-install`, since the judge refuses symbolic links in a build's outputs. Its verifiers for the interfaces, the three test suites and the launch tests require `builds`; `missions` and `rates` require `launch-tests` and have the highest `priority` numbers, so they run last. `missions` has four cells: `warehouse-a`, `warehouse-b` and the held-out `hidden-aisles` and `hidden-dock`. A mission cell's run sets a `ROS_DOMAIN_ID` and a `GZ_PARTITION` of its own, starts Gazebo's server headless (`gz sim -s -r`), the stack's bringup launch file and the kit's mission script, and records the topics with `ros2 bag record --use-sim-time`. Its check prints one line, such as `{"pass": true, "completed": 6, "missions": 6, "contacts": 0, "mission_s": 381.4}`, with `pass` false when a mission fails or the robot touches anything; `mission_s` is a number read from the check ([Contract](../../reference/contract.md#goal), [Kit manifest](../../reference/kit-manifest.md#verifiers)).

## What to expect

- **Time per check.** A colcon build, then a subsystem's tests, the launch tests, or missions in Gazebo, which take as long as the robot drives. After each promotion the judge checks every goal, and the threshold goal runs its world 5 times (`threshold_reps`). Cheap verifiers get the lower priority numbers, so a change that doesn't build fails before any mission starts.
- **Where the agents help most.** The bulk of the porting: build files, node APIs, launch and parameter files and tests, package after package, and the long tail of build and test errors.
- **Where people stay.** Porting the simulation model and worlds to Gazebo Harmonic, which are the kit's instrument; choosing the topics, rates and margins; reviewing what the tests and missions don't cover; every step onto the real robot.

## What the judge guards against

The easiest ways to pass a migration's checks are to leave part of the stack behind or to change the tests. The launch tests and missions test the stack from outside, the passing tests are held to the ROS 1 counts, and `insufficient` tells the auditor and the review panel that a stack partly on ROS 1, or with tests skipped, is not done. Simulation adds its own shortcuts: waypoints written for the visible worlds, or code that moves the robot through Gazebo's services. The hidden worlds catch the first; the agents learn which goal failed and how, never which world. For the second, and for a topic republished with stale data, the adversarial checklist sends every promotion to the auditor. The kit spawns its own robot model, so a change to the project's robot description can't make the simulated robot smaller, faster or blind to contact. The run's own `ROS_DOMAIN_ID` and `GZ_PARTITION` keep the judged stack from hearing the agents' test runs on the same machine.

## Limits

- Thermite never touches a real robot, and a rig measures on one machine: one robot's stack with its simulator, not a fleet. Real sensors, timing on the robot's computer and field tests are work for people.
- The CPU harness image is Debian bookworm, where Jazzy is Tier 3, built from source; its packages are for Ubuntu 24.04. Build the harness on an Ubuntu 24.04 base ([`BASE_IMAGE`](../../reference/harness-image.md#build-arguments)) and add ROS 2, Gazebo and the stack's dependencies. The judge builds with what the image holds, so whatever rosdep would install must be in it.
- A timed run may have 256 processes and threads at once, and 1,024 MiB of memory unless the kit raises `run.rss_mib`. Gazebo, Nav2 and the middleware start many threads: count them in a test of the kit.
- Sensors that render, such as cameras and Gazebo's GPU lidar, need a renderer: try them on the rig before you write goals on them.
- ROS 1 figures recorded in Gazebo Classic come from another simulator: rates carry over, mission times only roughly, so set the margin with that in mind.

## Who it's for

- **[Startups](../for/startups.mdx):** robotics companies that must move off Noetic without stopping work on the product.
- **[Enterprises](../for/enterprises.mdx):** product lines with many packages, run on your own machines against private repositories.

## Related work

ROS's [end-of-life page](https://www.ros.org/blog/noetic-eol/) says "ROS 1 Noetic Ninjemys goes End-of-Life 2025-05-31", that ROS 2 downloads made up "almost 80% of all ROS downloads" in September 2024, and that the bridge "is no longer fully supported by the current ROS 2 releases". The [ros1_bridge README](https://github.com/ros2/ros1_bridge) says "Ubuntu 24.04 LTS does not support ROS 1". Gazebo's team [announced](https://discourse.openrobotics.org/t/gazebo-classic-11-has-reached-end-of-life-x-post-gazebo-sim-community/41852) in February 2025 that "Gazebo Classic (Gazebo11) has reached end-of-life". ROS 2's [migration guides](https://docs.ros.org/en/jazzy/How-To-Guides/Migrating-from-ROS1.html) say how to port each part, and its [launch_testing tutorial](https://docs.ros.org/en/jazzy/Tutorials/Intermediate/Testing/Integration.html) that "nodes that are part of different tests shouldn't communicate with each other, even when run in parallel".

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project.
2. [Extend the harness image](../../how-to/install/extend-harness-image.md), on an Ubuntu 24.04 base, with ROS 2 Jazzy, Gazebo Harmonic and your dependencies, and add a rig from it.
3. [Write a kit](../../how-to/campaigns/write-a-kit.md#7-add-verifiers-for-goal-campaigns) whose verifiers require one another, and [test it](../../how-to/campaigns/test-a-kit.md) with the ROS 1 branch, which must fail `builds`, and with a branch that skips a test, which must fail its test goal.
