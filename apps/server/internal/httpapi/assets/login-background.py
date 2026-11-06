# Renders login-background.webp, the built-in sign-in background.
#   Blender -b --factory-startup -P login-background.py -- out.png 256 100
#   cwebp -q 86 out.png -o login-background.webp

import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = argv[0]
SAMPLES = int(argv[1]) if len(argv) > 1 else 64
RES_PCT = int(argv[2]) if len(argv) > 2 else 50

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

ACCENT = (0.243, 0.435, 0.878)  # #3e6fe0


def srgb_to_linear(c):
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)


def glass_material(name, tint, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*tint, 1)
    bsdf.inputs["Transmission Weight"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["IOR"].default_value = 1.47
    bsdf.inputs["Coat Weight"].default_value = 0.4
    bsdf.inputs["Coat Roughness"].default_value = 0.02
    return mat


def rounded_slab(name, width, height, depth, radius, mat):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (width, depth, height)
    bpy.ops.object.transform_apply(scale=True)
    # Round the four outline corners, then soften every edge.
    corners = obj.modifiers.new("corners", "BEVEL")
    corners.width = radius
    corners.segments = 16
    corners.limit_method = "ANGLE"
    corners.affect = "EDGES"
    corners.angle_limit = math.radians(30)
    # Only the edges parallel to the depth axis get the large radius.
    weights = obj.data.attributes.new("bevel_weight_edge", "FLOAT", "EDGE")
    for e in obj.data.edges:
        v0, v1 = (obj.data.vertices[i].co for i in e.vertices)
        weights.data[e.index].value = 1.0 if abs(v0.y - v1.y) > 1e-4 else 0.0
    corners.limit_method = "WEIGHT"
    soft = obj.modifiers.new("soft", "BEVEL")
    soft.width = depth * 0.42
    soft.segments = 8
    soft.limit_method = "ANGLE"
    obj.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return obj


# Three panels receding up and to the left, as in the mark.
panels = []
for i, (tint_mix, rough) in enumerate([(0.30, 0.02), (0.24, 0.03), (0.18, 0.05)]):
    tint = tuple(1 - tint_mix * (1 - a) for a in srgb_to_linear(ACCENT))
    mat = glass_material(f"glass{i}", tint, rough)
    slab = rounded_slab(f"panel{i}", 3.2, 1.9, 0.16, 0.18, mat)
    slab.location = (-1.05 * i, 1.25 * i, 0.62 * i)
    panels.append(slab)



def emitter(name, color, strength):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*srgb_to_linear(color), 1)
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs[0], out.inputs[0])
    return mat, nt, em


# Backdrop: a large plane behind the stack with a soft radial glow, so the
# glass has something to refract and the image is not flat black.
bpy.ops.mesh.primitive_plane_add(size=60)
backdrop = bpy.context.active_object
backdrop.rotation_euler = (math.radians(90), 0, math.radians(-22))
backdrop.location = (-6, 14, 0)
mat, nt, em = emitter("backdrop", (0.0, 0.0, 0.0), 1.0)
coord = nt.nodes.new("ShaderNodeTexCoord")
grad = nt.nodes.new("ShaderNodeTexGradient")
grad.gradient_type = "SPHERICAL"
mapping = nt.nodes.new("ShaderNodeMapping")
mapping.inputs["Location"].default_value = (-1.0, -1.0, 0)
mapping.inputs["Scale"].default_value = (2.6, 2.6, 0)
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (*srgb_to_linear((0.012, 0.016, 0.04)), 1)
ramp.color_ramp.elements[1].position = 1.0
ramp.color_ramp.elements[1].color = (*srgb_to_linear((0.10, 0.17, 0.42)), 1)
nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
nt.links.new(mapping.outputs[0], grad.inputs["Vector"])
nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], em.inputs["Color"])
backdrop.data.materials.append(mat)

def area_light(name, loc, target, size, power, color):
    data = bpy.data.lights.new(name, "AREA")
    data.size = size
    data.energy = power
    data.color = srgb_to_linear(color)
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = loc
    direction = Vector(target) - Vector(loc)
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


center = (-0.95, 0.95, 0.62)
area_light("key", (6, -2, 6), center, 1.5, 500, (0.85, 0.90, 1.0))
area_light("rim_blue", (-6, 6, 2), center, 3, 2400, (0.30, 0.50, 1.0))
area_light("rim_violet", (3, 7, -1), center, 2, 1600, (0.55, 0.40, 1.0))
area_light("top", (-1, 1, 7), center, 6, 900, (0.75, 0.85, 1.0))
area_light("fill", (-3, -6, -2), center, 6, 250, (0.40, 0.55, 0.95))

# Camera close on the front-right side so the stack fills the frame and runs
# off the right and bottom edges. CAM, LOOK, LENS, FSTOP, and FOCUS override it.
cam_data = bpy.data.cameras.new("cam")
cam_data.lens = float(os.environ.get("LENS", "35"))
cam_data.dof.use_dof = True
cam_data.dof.aperture_fstop = float(os.environ.get("FSTOP", "2.8"))
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = Vector(map(float, os.environ.get("CAM", "1.85,-3.25,1.4").split(",")))
look = Vector(center) + Vector(map(float, os.environ.get("LOOK", "0.1,-0.3,-0.05").split(",")))
cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_data.dof.focus_object = panels[int(os.environ.get("FOCUS", "1"))]

# Face the backdrop toward the camera, behind the stack.
view = (look - cam.location).normalized()
backdrop.location = Vector(center) + view * 16
backdrop.rotation_euler = (-view).to_track_quat("Z", "Y").to_euler()

# Rear lights shape the glass edges but must not show through it as panels.
for name in ("rim_blue", "rim_violet", "fill"):
    light = bpy.data.objects[name]
    light.visible_camera = False
    light.visible_transmission = False


scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "METAL"
prefs.get_devices()
for d in prefs.devices:
    d.use = True
scene.cycles.device = "GPU"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 16
scene.cycles.transmission_bounces = 16
scene.cycles.glossy_bounces = 8
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.render.resolution_x = 2560
scene.render.resolution_y = 1440
scene.render.resolution_percentage = RES_PCT
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
