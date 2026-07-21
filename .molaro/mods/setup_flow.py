# molaro-mod
# name: setup_flow
# kind: analysis
# produces: commands
# requires-channel: flow_dir
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: one invocation instead of two — needs the flow_dir channel, then binds it to orientation

# THE TEMPLATE for `# requires-channel:`. A mod can declare that it NEEDS a
# channel to be present before it runs. On invocation, if that channel is not
# already live, the mod that DECLARES it (its `# channel:` provider) is run FIRST,
# then this mod — one invocation instead of two.
#
# Here `flow_dir` is declared by the shipped `channel_flow` mod. Running
#   setup_flow all
# runs channel_flow first (declaring flow_dir), then binds it — instead of making
# the user run `channel_flow all` and then `bind all flow_dir orientation`.
#
# ONE LEVEL ONLY: the provider itself may not require a channel (deeper chains,
# cycles included, are refused). And sequencing is NOT atomicity: if the provider
# runs and this mod then fails, the channel stays declared (channels are
# append-only) — one undo covers this mod's commands, not the declaration.


def compute(data, target_indices):
    # a `produces: commands` mod: bind the required channel to the orientation
    # axis. flow_dir is guaranteed present (its provider ran first), so the bind
    # always finds it.
    return ["bind all flow_dir orientation"]
