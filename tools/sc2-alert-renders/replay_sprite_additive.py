"""Represent native additive M3 mesh materials in an RGBA sprite atlas.

An ordinary alpha atlas cannot retain destination-additive blending. Convert
black to transparency and keep the source light unlit, so effect cards do not
become opaque geometry. Reuse the reconstructed layer graph, including UVs,
channels, masks, and authored color multipliers.
"""
from __future__ import annotations


def correct_additive_materials(role):
    """Correct reconstructed native ADD materials; return their names.

    Call after ``reconstruct_role_materials`` on every team-color rebuild.
    The caller must exclude ADD materials from body diffuse team masking.
    """
    armature = role.armature
    if armature is None:
        return []
    standards = {str(getattr(item, "bl_handle", "")): item
                 for item in armature.m3_materials_standard}
    additive = {}
    for reference in armature.m3_materialrefs:
        if str(getattr(reference, "mat_type", "")) != "m3_materials_standard":
            continue
        standard = standards.get(str(getattr(reference, "mat_handle", "")))
        if standard is not None and str(standard.blend_mode) == "ADD":
            additive[f"SC2_{role.name}_{reference.name}"] = standard

    materials = {material for mesh in role.render_meshes
                 for material in mesh.data.materials if material}
    changed = []
    for material in materials:
        if material.name not in additive or not material.use_nodes:
            continue
        standard = additive[material.name]
        nodes, links = material.node_tree.nodes, material.node_tree.links
        if nodes.get("Replay_Additive_Output"):
            continue
        principled = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
        output = next((node for node in nodes if node.type == "OUTPUT_MATERIAL"), None)
        if principled is None or output is None:
            continue

        def linked(socket):
            return socket.links[0].from_socket if socket is not None and socket.is_linked else None

        def math(kind, first, second):
            node = nodes.new("ShaderNodeMath")
            node.operation = kind
            for index, value in enumerate((first, second)):
                if isinstance(value, (int, float)):
                    node.inputs[index].default_value = value
                else:
                    links.new(value, node.inputs[index])
            return node.outputs[0]

        base = linked(principled.inputs.get("Base Color"))
        emissive_input = principled.inputs.get("Emission Color") or principled.inputs.get("Emission")
        emissive = linked(emissive_input)
        # The generic sprite correction can add body-fill emission. Only
        # include an emission input when the source has an emissive layer.
        source_emission = any(str(getattr(standard, f"layer_{slot}", ""))
                              for slot in ("emis1", "emis2"))
        if not source_emission:
            emissive = None
        if emissive is not None:
            strength = principled.inputs.get("Emission Strength")
            scale = nodes.new("ShaderNodeVectorMath")
            scale.operation = "SCALE"
            links.new(emissive, scale.inputs[0])
            scale.inputs[3].default_value = float(strength.default_value) if strength else 1.0
            emissive = scale.outputs["Vector"]
        if base is not None and emissive is not None:
            add = nodes.new("ShaderNodeVectorMath")
            add.operation = "ADD"
            links.new(base, add.inputs[0])
            links.new(emissive, add.inputs[1])
            color = add.outputs["Vector"]
        else:
            color = emissive or base

        transparent = nodes.new("ShaderNodeBsdfTransparent")
        if color is None:
            # Do not turn an absent/zero effect layer into the renderer's
            # neutral body fallback, which creates an opaque helper card.
            transparent.name = "Replay_Additive_Output"
            links.new(transparent.outputs[0], output.inputs["Surface"])
        else:
            channels = nodes.new("ShaderNodeSeparateXYZ")
            links.new(color, channels.inputs[0])
            maximum = math("MAXIMUM", math("MAXIMUM", channels.outputs[0], channels.outputs[1]), channels.outputs[2])
            coverage = math("MINIMUM", math("MAXIMUM", maximum, 0.0), 1.0)
            normalized = nodes.new("ShaderNodeVectorMath")
            normalized.operation = "SCALE"
            links.new(color, normalized.inputs[0])
            links.new(math("DIVIDE", 1.0, math("MAXIMUM", coverage, 0.000001)), normalized.inputs[3])
            emission = nodes.new("ShaderNodeEmission")
            links.new(normalized.outputs["Vector"], emission.inputs["Color"])
            emission.inputs["Strength"].default_value = 1.0
            alpha = linked(principled.inputs.get("Alpha"))
            if alpha is not None:
                coverage = math("MULTIPLY", coverage, alpha)
            mix = nodes.new("ShaderNodeMixShader")
            mix.name = "Replay_Additive_Output"
            links.new(coverage, mix.inputs[0])
            links.new(transparent.outputs[0], mix.inputs[1])
            links.new(emission.outputs[0], mix.inputs[2])
            links.new(mix.outputs[0], output.inputs["Surface"])
        if hasattr(material, "surface_render_method"):
            material.surface_render_method = "DITHERED"
        elif hasattr(material, "blend_method"):
            material.blend_method = "BLEND"
        changed.append(material.name)
    return sorted(changed)
