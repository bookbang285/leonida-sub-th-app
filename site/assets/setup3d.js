/* The 3D wiring scene of /setup: PS5, capture cards, splitter, computer, TV, phone, and cables
   that run to their ports as the page is scrolled. Needs THREE (global). No models are
   downloaded: every device is built here from simple shapes.
   API: Setup3D.init(canvas) -> bool, Setup3D.configure({show, steps, card, mac}), Setup3D.progress(f) */
(function () {
  "use strict";
  var T = window.THREE, S = {}, ready = false;
  var renderer, scene, camera, cv, dirty = true, raf = 0;
  var devs = {}, cables = {}, airs = {}, screens = {}, glows = {};
  var cfg = { show: [], steps: [], card: "pass", mac: false }, frac = 0, fontOk = false;
  var HDMI = 0xf2b84b, USB = 0x7fb0ff, AIR = 0x6ee7a8, IDLE = 0x46536e;

  function V(x, y, z) { return new T.Vector3(x, y, z); }
  var CENTER = { "d-ps": V(-5.5, 2, 0), "d-card": V(0, .3, 2.2), "d-dongle": V(0, .3, 2.2), "d-split": V(-3, .3, 2.6),
                 "d-pc": V(5, 1, 1.8), "d-tv": V(0, 3.4, -2), "d-phone": V(0, .5, -3.6) };
  var PORT = {
    ps: [V(-5.5, .72, 1.34), V(0, 0, 1)],
    cardIn: [V(-.83, .2, 2.2), V(-1, 0, 0)], cardOut: [V(.83, .2, 2.2), V(1, 0, 0)], cardUsb: [V(0, .2, 2.73), V(0, 0, 1)],
    dongIn: [V(-.62, .2, 2.2), V(-1, 0, 0)], dongUsb: [V(.7, .2, 2.2), V(1, 0, 0)],
    splitIn: [V(-3.62, .22, 2.6), V(-1, 0, 0)], splitO1: [V(-2.38, .22, 2.6), V(1, 0, 0)], splitO2: [V(-3, .22, 2.13), V(0, 0, -1)],
    tv1: [V(2.6, 2.75, -1.84), V(0, 0, 1)]
  };

  var PC_AT = V(4.2, 0, 2.3), PC_TURN = 1.0;
  function onPc(x, y, z) { var c = Math.cos(PC_TURN), sn = Math.sin(PC_TURN); return V(PC_AT.x + x * c + z * sn, PC_AT.y + y, PC_AT.z - x * sn + z * c); }
  PORT.pcUsb = [onPc(-1.705, .11, .5), onPc(-1, 0, 0).sub(PC_AT)];
  PORT.pcHdmi = [onPc(-1.705, .11, -.3), onPc(-1, 0, 0).sub(PC_AT)];
  CENTER["d-pc"] = onPc(0, 1, 0);
  CENTER["d-pad"] = V(1.9, .3, 4.0);
  PORT.padUsb = [V(1.9, .22, 3.37), V(0, 0, -1)];        // the controller's USB-C socket is on its far edge

  function mat(color, rough, metal) { return new T.MeshStandardMaterial({ color: color, roughness: rough == null ? .6 : rough, metalness: metal || 0 }); }
  function box(w, h, d, m, x, y, z) { var b = new T.Mesh(new T.BoxGeometry(w, h, d), m); b.position.set(x || 0, y || 0, z || 0); b.castShadow = true; b.receiveShadow = true; return b; }
  function rbox(w, h, d, r, m) {                       // a box with rounded vertical edges (w x d rounded, extruded h)
    var s = new T.Shape(), x = -w / 2, z = -d / 2;
    s.moveTo(x + r, z); s.lineTo(x + w - r, z); s.quadraticCurveTo(x + w, z, x + w, z + r);
    s.lineTo(x + w, z + d - r); s.quadraticCurveTo(x + w, z + d, x + w - r, z + d);
    s.lineTo(x + r, z + d); s.quadraticCurveTo(x, z + d, x, z + d - r); s.lineTo(x, z + r); s.quadraticCurveTo(x, z, x + r, z);
    var g = new T.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelSize: .03, bevelThickness: .03, bevelSegments: 2, curveSegments: 8 });
    g.rotateX(-Math.PI / 2); g.translate(0, -h / 2, 0);
    var me = new T.Mesh(g, m); me.castShadow = true; me.receiveShadow = true; return me;
  }
  function label(text, size) {
    var c = document.createElement("canvas"); c.width = 512; c.height = 96;
    var tex = new T.CanvasTexture(c);
    var sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: !!size && size >= 1 }));
    sp.scale.set((size || 1) * 3.2, (size || 1) * .6, 1); sp.renderOrder = 10;
    sp.userData.draw = function (hot) {
      var g = c.getContext("2d"); g.clearRect(0, 0, 512, 96);
      g.font = "500 40px Prompt, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      var w = g.measureText(text).width + 44;
      g.fillStyle = hot ? "rgba(242,184,75,.96)" : "rgba(14,22,40,.82)";
      rr(g, 256 - w / 2, 14, w, 68, 20); g.fill();
      g.fillStyle = hot ? "#1a1205" : "#dbe4f2"; g.fillText(text, 256, 50); tex.needsUpdate = true;
    };
    sp.userData.draw(false); return sp;
  }
  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function port(m, w, h) { return box(w || .3, h || .13, .05, m || mat(0x06090f, .4)); }
  function glow(id, p, big) {                          // a ring that lights up around the port being used
    var g = new T.Mesh(new T.TorusGeometry(big ? .34 : .26, .035, 8, 28), new T.MeshBasicMaterial({ color: HDMI, transparent: true, opacity: 0 }));
    g.position.copy(p[0]).addScaledVector(p[1], .02);
    g.lookAt(p[0].clone().add(p[1])); glows[id] = g; scene.add(g);
  }

  // ---------- devices ----------
  function decal(text, w, h, color) {                  // small printed text on a surface
    var c = document.createElement("canvas"); c.width = 512; c.height = Math.round(512 * h / w);
    var g = c.getContext("2d"); g.font = "600 " + Math.round(c.height * .62) + "px Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = color || "rgba(214,222,236,.85)"; g.fillText(text, 256, c.height / 2);
    var m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ map: new T.CanvasTexture(c), transparent: true }));
    return m;
  }
  var METAL = null, HOLE = null, USBIN = null;
  function jack(kind) {                                // a socket with its metal rim, facing +Z
    METAL = METAL || mat(0xaab3c2, .3, .85); HOLE = HOLE || mat(0x05070b, .5); USBIN = USBIN || mat(0x1d4ed8, .4);
    var g = new T.Group(), w = kind === "usb" ? .27 : kind === "lan" ? .24 : kind === "pwr" ? .3 : .34, h = kind === "lan" ? .2 : kind === "pwr" ? .17 : .15;
    g.add(box(w + .06, h + .06, .03, METAL, 0, 0, 0)); g.add(box(w, h, .04, HOLE, 0, 0, .004));
    if (kind === "usb") g.add(box(w * .8, .03, .042, USBIN, 0, -.02, .006));
    return g;
  }
  function slats(n, w, step, m) { var g = new T.Group(); for (var i = 0; i < n; i++) g.add(box(w, .03, .03, m, 0, i * step, 0)); return g; }
  function feet(g, w, d) { var m = mat(0x0a0c11, .9); [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (s) { var f = new T.Mesh(new T.CylinderGeometry(.07, .07, .03, 12), m); f.position.set(s[0] * w, .015, s[1] * d); g.add(f); }); }

  function buildPS5() {
    var g = new T.Group(), white = mat(0xf3f5f9, .32), black = new T.MeshStandardMaterial({ color: 0x0b0d13, roughness: .18, metalness: .35 });
    g.add(box(.72, 3.7, 2.45, black, 0, 1.95, 0));
    [-1, 1].forEach(function (s) {                     // the two white shells, flaring out at the top
      var sh = new T.Shape(); sh.moveTo(-1.38, 0); sh.lineTo(1.38, 0); sh.bezierCurveTo(1.6, 1.4, 1.56, 3.2, 1.3, 4.12); sh.quadraticCurveTo(0, 4.42, -1.3, 4.12); sh.bezierCurveTo(-1.56, 3.2, -1.6, 1.4, -1.38, 0);
      var m = new T.Mesh(new T.ExtrudeGeometry(sh, { depth: .1, bevelEnabled: true, bevelSize: .04, bevelThickness: .04, bevelSegments: 3, curveSegments: 18 }), white);
      m.rotation.y = Math.PI / 2; m.position.set(s * .47 - .05, .06, 0); m.rotation.z = s * -.05; m.castShadow = true; g.add(m);
      var strip = box(.025, 3.2, 2.2, new T.MeshBasicMaterial({ color: 0x4aa8ff }), s * .372, 2.1, 0); g.add(strip);   // the light between shell and core
    });
    var st = new T.Mesh(new T.CylinderGeometry(.98, 1.04, .09, 48), black); st.position.y = .045; st.castShadow = true; g.add(st);
    var ring = new T.Mesh(new T.TorusGeometry(.98, .02, 8, 48), mat(0x2a3040, .4, .6)); ring.rotation.x = Math.PI / 2; ring.position.y = .09; g.add(ring);
    // back: a field of vents above, the ports panel below
    var v = slats(15, .56, .135, mat(0x1c212d, .5)); v.position.set(0, 1.55, 1.232); g.add(v);
    g.add(box(.6, 1.02, .02, mat(0x141821, .5), 0, .64, 1.232));
    var h = jack(); h.position.set(0, .72, 1.25); g.add(h);
    [-.16, .16].forEach(function (x) { var u = jack("usb"); u.scale.set(.75, .8, 1); u.position.set(x, .98, 1.25); g.add(u); });
    var lan = jack("lan"); lan.position.set(0, .46, 1.25); g.add(lan);
    var pw = jack("pwr"); pw.position.set(0, .22, 1.25); g.add(pw);
    var t = decal("HDMI", .26, .07); t.position.set(.0, .86, 1.246); g.add(t);
    g.position.set(-5.5, 0, 0); return g;
  }
  function buildCard() {
    var g = new T.Group(), body = rbox(2.2, .46, 1.4, .18, mat(0x1a2030, .42, .35)); body.position.y = .29; g.add(body);
    g.add(box(1.86, .012, 1.06, mat(0x232b40, .3, .5), 0, .535, 0));                     // the glossy top plate
    var name = decal("4K CAPTURE", 1.2, .2); name.rotation.x = -Math.PI / 2; name.rotation.z = Math.PI; name.position.set(0, .545, -.1); g.add(name);
    var led = new T.Mesh(new T.SphereGeometry(.04, 12, 12), new T.MeshBasicMaterial({ color: 0xff5a5a })); led.position.set(.78, .55, .5); g.add(led);
    feet(g, .85, .5);
    var i = jack(); i.rotation.y = -Math.PI / 2; i.position.set(-1.105, .27, 0); g.add(i);
    var o = jack(); o.rotation.y = Math.PI / 2; o.position.set(1.105, .27, 0); g.add(o);
    var u = jack("usb"); u.position.set(0, .27, .705); g.add(u);
    var ti = decal("IN", .26, .13); ti.rotation.x = -Math.PI / 2; ti.rotation.z = Math.PI; ti.position.set(-.86, .546, 0); g.add(ti);
    var to = decal("OUT", .36, .13); to.rotation.x = -Math.PI / 2; to.rotation.z = Math.PI; to.position.set(.82, .546, 0); g.add(to);
    g.scale.set(.74, .74, .74); g.position.set(0, 0, 2.2); return g;
  }
  function buildDongle() {
    var g = new T.Group(), body = rbox(1.2, .26, .52, .12, mat(0x8a93a3, .3, .8)); body.position.y = .2; g.add(body);
    var name = decal("HDMI CAPTURE", .9, .13, "rgba(20,26,38,.9)"); name.rotation.x = -Math.PI / 2; name.rotation.z = Math.PI; name.position.set(0, .345, 0); g.add(name);
    var i = jack(); i.rotation.y = -Math.PI / 2; i.position.set(-.605, .2, 0); g.add(i);
    var out = new T.Mesh(new T.CylinderGeometry(.06, .1, .16, 12), mat(0x10141c, .6)); out.rotation.z = Math.PI / 2; out.position.set(.66, .2, 0); g.add(out);   // where its own USB lead leaves the body
    g.position.set(0, 0, 2.2); return g;
  }
  function buildSplit() {
    var g = new T.Group(), body = rbox(1.2, .34, .9, .08, mat(0x2a3246, .35, .7)); body.position.y = .22; g.add(body);
    var name = decal("HDMI SPLITTER 1x2", 1.0, .12); name.rotation.x = -Math.PI / 2; name.rotation.z = Math.PI; name.position.set(0, .405, .1); g.add(name);
    var a = jack(); a.rotation.y = -Math.PI / 2; a.position.set(-.605, .22, 0); g.add(a);
    var b = jack(); b.rotation.y = Math.PI / 2; b.position.set(.605, .22, 0); g.add(b);
    var c = jack(); c.rotation.y = Math.PI; c.position.set(0, .22, -.455); g.add(c);
    [-.12, 0, .12].forEach(function (x, k) { var led = new T.Mesh(new T.SphereGeometry(.028, 10, 10), new T.MeshBasicMaterial({ color: k ? AIR : 0xff5a5a })); led.position.set(.3 + x, .4, -.25); g.add(led); });
    feet(g, .45, .32);
    g.position.set(-3, 0, 2.6); return g;
  }
  function screenTex(id, w, h) {
    var c = document.createElement("canvas"); c.width = w; c.height = h;
    var tex = new T.CanvasTexture(c); screens[id] = { c: c, tex: tex, mode: "" }; return tex;
  }
  function buildPC() {
    var g = new T.Group(), alu = mat(0x8c95a4, .5, .55), dark = mat(0x12161f, .6);
    var base = rbox(3.4, .2, 2.4, .22, alu); base.position.y = .11; g.add(base);
    g.add(box(3.0, .012, 1.22, dark, 0, .216, .22));                                      // keyboard well
    var keys = new T.InstancedMesh(new T.BoxGeometry(.185, .03, .17), mat(0x1d2330, .7), 14 * 5), mx = new T.Matrix4(), n = 0;
    for (var r = 0; r < 5; r++) for (var c = 0; c < 14; c++) { mx.setPosition(-1.36 + c * .209, .232, -.26 + r * .22); keys.setMatrixAt(n++, mx); }
    keys.position.z = .04; g.add(keys);
    g.add(box(1.25, .012, .72, mat(0x6f7887, .3, .5), 0, .216, -.78));                    // trackpad
    var hinge = new T.Mesh(new T.CylinderGeometry(.07, .07, 2.6, 16), mat(0x7e8796, .4, .8)); hinge.rotation.z = Math.PI / 2; hinge.position.set(0, .22, 1.16); g.add(hinge);
    var lid = new T.Group(), shell = rbox(3.4, .09, 2.25, .22, alu); shell.rotation.x = Math.PI / 2; lid.add(shell);
    var bezel = new T.Mesh(new T.PlaneGeometry(3.3, 2.14), new T.MeshStandardMaterial({ color: 0x06080c, roughness: .3 })); bezel.rotation.y = Math.PI; bezel.position.z = -.088; lid.add(bezel);
    var scr = new T.Mesh(new T.PlaneGeometry(3.14, 1.96), new T.MeshBasicMaterial({ map: screenTex("pc", 640, 400) }));
    scr.rotation.y = Math.PI; scr.position.set(0, -.02, -.092); lid.add(scr);
    var cam = new T.Mesh(new T.CircleGeometry(.025, 12), new T.MeshBasicMaterial({ color: 0x2a3344 })); cam.rotation.y = Math.PI; cam.position.set(0, 1.02, -.093); lid.add(cam);
    lid.position.set(0, 1.3, 1.24); lid.rotation.x = -.2; g.add(lid);
    var u = jack("usb"); u.rotation.y = -Math.PI / 2; u.scale.set(.9, .62, 1); u.position.set(-1.705, .11, .5); g.add(u);
    var uc = jack(); uc.rotation.y = -Math.PI / 2; uc.scale.set(.5, .42, 1); uc.position.set(-1.705, .11, .5); uc.visible = false; g.add(uc);
    S.usbA = u; S.usbC = uc;                           // Windows laptop: USB-A; Mac: USB-C
    var h = jack(); h.rotation.y = -Math.PI / 2; h.scale.set(.85, .62, 1); h.position.set(-1.705, .11, -.3); g.add(h);
    g.position.copy(PC_AT); g.rotation.y = PC_TURN; return g;
  }
  function buildTV() {
    var g = new T.Group(), dark = mat(0x10141c, .45, .25), back = mat(0x171c27, .7);
    g.add(box(9.2, 5.3, .16, dark, 0, 3.55, -.03));
    var scr = new T.Mesh(new T.PlaneGeometry(9.02, 5.1), new T.MeshBasicMaterial({ map: screenTex("tv", 896, 504) }));
    scr.rotation.y = Math.PI; scr.position.set(0, 3.57, -.112); g.add(scr);
    var led = new T.Mesh(new T.CircleGeometry(.03, 10), new T.MeshBasicMaterial({ color: 0xff4d4d })); led.rotation.y = Math.PI; led.position.set(0, .95, -.113); g.add(led);
    g.add(box(9.0, 5.1, .06, back, 0, 3.55, .08));                                        // the back cover
    g.add(box(4.6, 2.5, .34, back, 0, 2.7, .2));                                          // the thicker lower part
    var v = slats(9, 3.6, .12, mat(0x0b0e14, .8)); v.position.set(0, 4.2, .115); g.add(v);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (s) { var sc = new T.Mesh(new T.CylinderGeometry(.06, .06, .03, 12), mat(0x3a4254, .4, .8)); sc.rotation.x = Math.PI / 2; sc.position.set(s[0] * .9, 2.9 + s[1] * .7, .385); g.add(sc); });
    g.add(box(.62, 1.5, .1, mat(0x0c0f15, .6), 2.6, 2.5, .2));                            // the ports strip
    var h1 = jack(); h1.position.set(2.6, 2.75, .26); g.add(h1);
    var h2 = jack(); h2.position.set(2.6, 2.4, .26); g.add(h2);
    var us = jack("usb"); us.scale.set(.8, .8, 1); us.position.set(2.6, 2.08, .26); g.add(us);
    var t1 = decal("HDMI 1", .34, .08); t1.position.set(3.14, 2.75, .14); g.add(t1);
    var t2 = decal("HDMI 2", .34, .08); t2.position.set(3.14, 2.4, .14); g.add(t2);
    [-1, 1].forEach(function (s) {                                                        // two angled feet
      var leg = box(.12, .1, 2.0, dark, s * 2.9, .05, 0); g.add(leg);
      var up = box(.12, .95, .12, dark, s * 2.9, .5, 0); g.add(up);
    });
    g.position.set(0, 0, -2); return g;
  }
  function buildPhone() {
    var g = new T.Group(), body = rbox(2.3, .11, 1.1, .2, mat(0x1b2130, .3, .6)); body.rotation.x = Math.PI / 2; g.add(body);
    var glass = new T.Mesh(new T.PlaneGeometry(2.22, 1.02), new T.MeshStandardMaterial({ color: 0x04060a, roughness: .2 })); glass.rotation.y = Math.PI; glass.position.z = -.097; g.add(glass);
    var scr = new T.Mesh(new T.PlaneGeometry(2.1, .92), new T.MeshBasicMaterial({ map: screenTex("phone", 512, 224) }));
    scr.rotation.y = Math.PI; scr.position.z = -.1; g.add(scr);
    var stand = box(.9, .5, .06, mat(0x2a3246, .6), 0, -.2, .3); stand.rotation.x = -.7; g.add(stand);
    g.position.set(0, .62, -3.6); g.rotation.x = .22; return g;
  }

  // the controller: with Remote Play it is wired to the computer, not to the console
  function buildPad() {
    var g = new T.Group(), white = mat(0xe9edf3, .45, .05), dark = mat(0x161a24, .5, .1);
    var body = rbox(1.9, .22, .8, .28, white); body.position.set(0, .2, -.22); g.add(body);
    [-1, 1].forEach(function (sd) {
      var grip = new T.Mesh(new T.SphereGeometry(.4, 20, 14), white); grip.scale.set(.95, .5, 1.65); grip.position.set(sd * .74, .2, .2); grip.rotation.y = sd * -.22; grip.castShadow = true; g.add(grip);
      var well = new T.Mesh(new T.CylinderGeometry(.17, .17, .04, 20), dark); well.position.set(sd * .36, .325, .02); g.add(well);
      var stick = new T.Mesh(new T.CylinderGeometry(.12, .1, .12, 20), dark); stick.position.set(sd * .36, .38, .02); stick.castShadow = true; g.add(stick);
      var bump = new T.Mesh(new T.CylinderGeometry(.5, .5, .1, 4, 1, false, Math.PI / 4), dark); bump.scale.set(.42, 1, .16); bump.position.set(sd * .62, .33, -.6); g.add(bump);
    });
    g.add(box(.78, .03, .42, dark, 0, .325, -.36));                                  // touch pad
    g.add(box(.8, .012, .03, new T.MeshBasicMaterial({ color: USB }), 0, .33, -.135));  // light bar
    [[-.74, -.3], [-.86, -.18], [-.62, -.18], [-.74, -.06]].forEach(function (b) { var k = new T.Mesh(new T.CylinderGeometry(.05, .05, .03, 12), dark); k.position.set(b[0], .325, b[1]); g.add(k); });
    [[.74, -.3], [.86, -.18], [.62, -.18], [.74, -.06]].forEach(function (b) { var k = new T.Mesh(new T.CylinderGeometry(.055, .055, .03, 12), mat(0xc9d0db, .4)); k.position.set(b[0], .325, b[1]); g.add(k); });
    g.add(box(.2, .08, .04, dark, 0, .2, -.63));                                     // USB-C socket
    g.position.set(1.9, 0, 4.0); return g;
  }

  // ---------- cables ----------
  // A cable is a whole thing from the start: it lies on the desk, then one plug is lifted into its
  // socket, then the other. The rubber is rebuilt each frame from where the two plugs are, hanging
  // down from a raised socket and lying in a lazy curve on the desk, the way a real one does.
  var RUBBER = 0x14171f;
  function sm(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
  function cable(id, a, b, color, captive) {
    var A = PORT[a], B = PORT[b], usb = color === USB;
    var m = new T.MeshStandardMaterial({ color: RUBBER, roughness: .5, metalness: .05, transparent: true });
    var tube = new T.Mesh(new T.BufferGeometry(), m); tube.castShadow = true;
    var pm = new T.MeshStandardMaterial({ color: 0x1a1e28, roughness: .45, metalness: .2, transparent: true });
    var tipM = new T.MeshStandardMaterial({ color: 0xc3cad6, roughness: .25, metalness: .9, transparent: true });
    function plug() {
      var p = new T.Group();
      var body = rbox(usb ? .27 : .34, usb ? .14 : .17, .44, .05, pm); body.position.z = -.22; p.add(body);
      var tip = box(usb ? .21 : .28, usb ? .075 : .1, .2, tipM, 0, 0, .09); p.add(tip); p.userData.tip = tip;
      var relief = new T.Mesh(new T.CylinderGeometry(usb ? .05 : .065, .1, .26, 12), pm); relief.rotation.x = Math.PI / 2; relief.position.z = -.56; p.add(relief);
      var band = box(usb ? .275 : .345, .02, .1, new T.MeshBasicMaterial({ color: color, transparent: true }), 0, (usb ? .07 : .085) + .008, -.2); p.add(band);   // a colour mark so the cable can be told apart
      p.userData.band = band; return p;
    }
    var pa = plug(), pb = plug(), grp = new T.Group(); grp.add(tube, pa, pb); grp.visible = false; scene.add(grp);
    if (captive) pa.visible = false;                    // this end is part of the device: no plug, the lead just comes out
    // side each loose end rests on, so two cables of one device do not lie on each other
    var side = (id.length % 2 ? 1 : -1);
    cables[id] = { g: grp, tube: tube, pa: pa, pb: pb, A: A, B: B, mat: m, pm: pm, tipM: tipM, color: color, r: usb ? .048 : .066, side: side, q: -1, hot: null, captive: !!captive, out: Math.max(.8, Math.min(1.5, A[0].distanceTo(B[0]) * .36)) };
  }
  // where a plug is, k = 0 lying loose on the desk .. 1 pushed home
  function plugAt(P, k, side, reach) {
    var p = P[0], n = P[1], sideV = V(-n.z, 0, n.x).multiplyScalar(side);
    var rest = p.clone().addScaledVector(n, reach).addScaledVector(sideV, reach < 1.2 ? .7 : .45); rest.y = .11;
    var pre = p.clone().addScaledVector(n, .62), home = p.clone().addScaledVector(n, .1);
    var pos, t;
    if (k < .7) { t = sm(k / .7); pos = rest.clone().lerp(pre, t); pos.y += Math.sin(Math.PI * t) * .32; }
    else { t = sm((k - .7) / .3); pos = pre.clone().lerp(home, t); }
    var loose = 1 - sm(k / .6);
    var axis = n.clone().addScaledVector(sideV, .55 * loose).normalize();           // points away from the socket, along the cable
    return { pos: pos, axis: axis };
  }
  // the run of the rubber from the back of one plug down to the desk
  function drop(e) {
    var back = e.pos.clone().addScaledVector(e.axis, .68), out = [back];
    var h = back.y - .075;
    if (h > .5) {                                       // a raised socket: out a little, then hang straight down
      out.push(back.clone().addScaledVector(e.axis, .22 + h * .03).add(V(0, -h * .22, 0)));
      out.push(back.clone().addScaledVector(e.axis, .34 + h * .04).add(V(0, -h * .62, 0)));
      out.push(back.clone().addScaledVector(e.axis, .55 + h * .1).setY(.075));
    } else {
      out.push(back.clone().addScaledVector(e.axis, .32).add(V(0, -h * .45, 0)));
      out.push(back.clone().addScaledVector(e.axis, .7).setY(.075));
    }
    return out;
  }
  function setCable(c, q, hot) {
    c.g.visible = q > 0.001;
    if (!c.g.visible) { c.q = -1; return; }
    if (Math.abs(q - c.q) < .0008 && hot === c.hot) return;
    c.q = q; c.hot = hot;
    var fade = sm(q / .1), ea, eb;
    if (c.captive) { ea = { pos: c.A[0].clone().addScaledVector(c.A[1], -.68), axis: c.A[1].clone() }; eb = plugAt(c.B, sm((q - .12) / .84), c.side, c.out); }
    else { ea = plugAt(c.A, sm((q - .1) / .38), c.side, c.out); eb = plugAt(c.B, sm((q - .52) / .44), c.side, c.out); }
    if (c.color === USB) c.pb.userData.tip.scale.set(cfg.mac ? .58 : 1, cfg.mac ? .7 : 1, 1);      // a Mac takes USB-C: a smaller tip
    var da = drop(ea), db = drop(eb), ta = da[da.length - 1], tb = db[db.length - 1];
    var d = tb.clone().sub(ta), len = d.length(), perp = len > .001 ? V(-d.z, 0, d.x).normalize() : V(0, 0, 1);
    var pts = da.slice();
    if (len < 1.6) pts.push(ta.clone().lerp(tb, .5).addScaledVector(perp, c.side * (.85 - len * .2)));          // short run: the spare length loops to one side
    else {
      var bulge = Math.min(1.1, .22 * len);
      pts.push(ta.clone().lerp(tb, .3).addScaledVector(perp, c.side * bulge * .7));
      pts.push(ta.clone().lerp(tb, .68).addScaledVector(perp, -c.side * bulge * .45));
    }
    for (var i = db.length - 1; i >= 0; i--) pts.push(db[i]);
    pts.forEach(function (p) { if (p.y < .075) p.y = .075; });
    var curve = new T.CatmullRomCurve3(pts, false, "centripetal");
    c.tube.geometry.dispose();
    c.tube.geometry = new T.TubeGeometry(curve, 96, c.r, 10, false);
    [[c.pa, ea], [c.pb, eb]].forEach(function (x) { x[0].position.copy(x[1].pos); x[0].lookAt(x[1].pos.clone().sub(x[1].axis)); });
    [c.mat, c.pm, c.tipM, c.pa.userData.band.material, c.pb.userData.band.material].forEach(function (mm) { mm.opacity = fade; });
    c.mat.emissive.setHex(hot ? c.color : 0); c.mat.emissiveIntensity = hot ? .2 : 0;
    c.pm.emissive.setHex(hot ? c.color : 0); c.pm.emissiveIntensity = hot ? .12 : 0;
  }
  function air(id, from, to) {
    var a = CENTER[from].clone().add(V(0, .9, 0)), b = CENTER[to].clone().add(V(0, .9, 0)), mid = a.clone().lerp(b, .5); mid.y += 2.4;
    var curve = new T.QuadraticBezierCurve3(a, mid, b), g = new T.Group(), dots = [];
    var line = new T.Line(new T.BufferGeometry().setFromPoints(curve.getPoints(40)), new T.LineBasicMaterial({ color: AIR, transparent: true, opacity: .28 }));
    g.add(line);
    for (var i = 0; i < 5; i++) { var d = new T.Mesh(new T.SphereGeometry(.06, 10, 10), new T.MeshBasicMaterial({ color: AIR })); dots.push(d); g.add(d); }
    g.visible = false; scene.add(g); airs[id] = { g: g, dots: dots, curve: curve };
  }

  // ---------- screens ----------
  var SUB_TH = "ฉันไปเจอผู้ชายคนนึงที่ช่วยเรื่องรถได้", SUB_EN = "I found a guy who can help with the car.";
  function gameArt(g, x, y, w, h) {
    var gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, "#ffb072"); gr.addColorStop(.48, "#e0527c"); gr.addColorStop(1, "#2b1f58");
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    g.fillStyle = "rgba(255,226,170,.92)"; g.beginPath(); g.arc(x + w * .7, y + h * .52, h * .15, 0, 7); g.fill();
    g.fillStyle = "#1a1133";                                   // a skyline of towers against the sunset
    [[0, .5, .07], [.08, .38, .05], [.14, .56, .08], [.24, .3, .06], [.31, .46, .07], [.4, .6, .1], [.52, .42, .05], [.58, .52, .09], [.78, .4, .06], [.85, .55, .08], [.94, .34, .06]].forEach(function (b) {
      g.fillRect(x + b[0] * w, y + b[1] * h, b[2] * w, h * (1 - b[1]));
    });
    g.fillStyle = "#120b26"; g.fillRect(x, y + h * .8, w, h * .2);
    g.fillStyle = "#0d0820";                                   // two palms in front
    [[.2, .26], [.68, .34]].forEach(function (p) {
      var px = x + p[0] * w, py = y + p[1] * h; g.fillRect(px - w * .004, py, w * .008, h * .6);
      for (var k = 0; k < 7; k++) { g.beginPath(); g.ellipse(px + Math.cos(k * .9 + .3) * w * .035, py + Math.sin(k * .9 + .3) * h * .03, w * .045, h * .013, k * .9 + .3, 0, 7); g.fill(); }
    });
  }
  function subtitle(g, w, h, y, fs) {
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = "600 " + fs + "px Prompt, sans-serif";
    var tw = g.measureText(SUB_TH).width + fs * 1.3;
    g.fillStyle = "rgba(6,9,15,.82)"; rr(g, w / 2 - tw / 2, y - fs * .8, tw, fs * 1.6, fs * .28); g.fill();
    g.fillStyle = "#fff"; g.fillText(SUB_TH, w / 2, y + fs * .04);
  }
  function menu(g, w, h, path, rows) {                         // a console settings page
    g.fillStyle = "#0c1830"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#9db4d6"; g.font = "500 " + Math.round(h * .055) + "px Prompt, Arial, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(path, w * .07, h * .13);
    rows.forEach(function (r, k) {
      var y = h * (.27 + k * .17), hot = r[2];
      g.fillStyle = hot ? "#1c3a6e" : "#122445"; rr(g, w * .07, y, w * .86, h * .13, h * .02); g.fill();
      if (hot) { g.strokeStyle = "#f2b84b"; g.lineWidth = h * .012; rr(g, w * .07, y, w * .86, h * .13, h * .02); g.stroke(); }
      g.fillStyle = "#e6ebf3"; g.font = "500 " + Math.round(h * .06) + "px Prompt, Arial, sans-serif"; g.fillText(r[0], w * .1, y + h * .068);
      var on = r[1], tx = w * .8;
      g.fillStyle = on ? "#3b82f6" : "#39465f"; rr(g, tx, y + h * .035, w * .09, h * .06, h * .03); g.fill();
      g.fillStyle = "#fff"; g.beginPath(); g.arc(tx + (on ? w * .068 : w * .022), y + h * .065, h * .022, 0, 7); g.fill();
    });
  }
  function appWindow(g, w, h, title, withGame) {
    g.fillStyle = "#0b101b"; g.fillRect(0, 0, w, h);
    var x = w * .09, y = h * .08, ww = w * .82, hh = h * .84;
    g.fillStyle = "#182135"; rr(g, x, y, ww, hh, h * .025); g.fill();
    g.fillStyle = "#c9d3e4"; g.font = "500 " + Math.round(h * .052) + "px Prompt, Arial, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(title, x + ww * .04, y + hh * .07);
    if (withGame) gameArt(g, x + ww * .04, y + hh * .15, ww * .92, hh * .66);
    return [x, y, ww, hh];
  }
  function paintScreen(id, mode) {
    var s = screens[id]; if (!s || (s.mode === mode && fontOk === s.font)) return;
    s.mode = mode; s.font = fontOk;
    var c = s.c, g = c.getContext("2d"), w = c.width, h = c.height, b;
    g.fillStyle = "#05070c"; g.fillRect(0, 0, w, h);
    if (mode === "game" || mode === "game sub") gameArt(g, 0, 0, w, h);
    if (mode === "game sub") subtitle(g, w, h, h * .86, Math.round(h * .07));
    if (mode === "sub") {                                      // the phone: Thai big, the English line small under it
      g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#fff"; g.font = "600 " + Math.round(h * .17) + "px Prompt, sans-serif"; g.fillText(SUB_TH, w / 2, h * .42);
      g.fillStyle = "#8d9ab0"; g.font = "400 " + Math.round(h * .1) + "px Prompt, Arial, sans-serif"; g.fillText(SUB_EN, w / 2, h * .7);
    }
    if (mode === "menu-hdcp") menu(g, w, h, "Settings  ›  System  ›  HDMI", [["Enable HDMI Device Link", true], ["Enable HDCP", false, true], ["Enable One-Touch Play", true]]);
    if (mode === "tv-install-a") {                              // Android TV: the Downloader app with our address typed in
      g.fillStyle = "#11161f"; g.fillRect(0, 0, w, h);
      g.fillStyle = "#f08a24"; g.fillRect(0, 0, w, h * .16);
      g.fillStyle = "#fff"; g.font = "600 " + Math.round(h * .075) + "px Prompt, Arial, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText("Downloader", w * .06, h * .085);
      g.fillStyle = "#9aa6ba"; g.font = "500 " + Math.round(h * .05) + "px Prompt, Arial, sans-serif"; g.fillText("Enter a URL", w * .08, h * .31);
      g.fillStyle = "#1d2636"; rr(g, w * .08, h * .38, w * .66, h * .17, h * .02); g.fill();
      g.strokeStyle = "#f2b84b"; g.lineWidth = h * .014; rr(g, w * .08, h * .38, w * .66, h * .17, h * .02); g.stroke();
      g.fillStyle = "#fff"; g.font = "600 " + Math.round(h * .075) + "px Prompt, Arial, sans-serif"; g.fillText("leonidasubth.com/tv.apk", w * .1, h * .47);
      g.fillStyle = "#f08a24"; rr(g, w * .77, h * .38, w * .15, h * .17, h * .02); g.fill();
      g.fillStyle = "#fff"; g.textAlign = "center"; g.fillText("Go", w * .845, h * .47);
      g.fillStyle = "#9aa6ba"; g.font = "500 " + Math.round(h * .05) + "px Prompt, Arial, sans-serif"; g.textAlign = "left"; g.fillText("แล้วกด Install และอนุญาต แสดงทับแอปอื่น", w * .08, h * .7);
    }
    if (mode === "tv-install-o" || mode === "tv-wait") {       // our TV app: being installed from the computer / connected
      g.fillStyle = "#0b1020"; g.fillRect(0, 0, w, h);
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillStyle = "#fff"; g.font = "600 " + Math.round(h * .1) + "px Prompt, Arial, sans-serif"; g.fillText("Leonida Sub TH TV", w / 2, h * .34);
      if (mode === "tv-wait") {
        g.fillStyle = "#6ee7a8"; g.beginPath(); g.arc(w * .3, h * .56, h * .022, 0, 7); g.fill();
        g.font = "500 " + Math.round(h * .07) + "px Prompt, Arial, sans-serif"; g.fillText("เชื่อมกับคอมแล้ว", w / 2 + w * .02, h * .56);
      } else {
        g.fillStyle = "#9aa6ba"; g.font = "500 " + Math.round(h * .06) + "px Prompt, Arial, sans-serif"; g.fillText("กำลังติดตั้งจากคอม", w / 2, h * .53);
        g.fillStyle = "#1d2636"; rr(g, w * .25, h * .64, w * .5, h * .04, h * .02); g.fill();
        g.fillStyle = "#7fb0ff"; rr(g, w * .25, h * .64, w * .31, h * .04, h * .02); g.fill();
      }
    }
    if (mode === "menu-rp") menu(g, w, h, "Settings  ›  System  ›  Remote Play", [["Enable Remote Play", true, true], ["Link Device", false], ["Connection History", false]]);
    if (mode === "app") {
      b = appWindow(g, w, h, "Leonida Sub TH", false);
      g.fillStyle = "#2b3854"; g.fillRect(b[0] + b[2] * .05, b[1] + b[3] * .2, b[2] * .6, b[3] * .035); g.fillRect(b[0] + b[2] * .05, b[1] + b[3] * .29, b[2] * .46, b[3] * .035);
      g.fillStyle = "#e0a93a"; rr(g, b[0] + b[2] * .05, b[1] + b[3] * .4, b[2] * .9, b[3] * .11, h * .02); g.fill();
      g.fillStyle = "#fff"; g.fillRect(b[0] + b[2] * .05, b[1] + b[3] * .58, b[3] * .3, b[3] * .3); g.fillStyle = "#111";
      for (var qx = 0; qx < 6; qx++) for (var qy = 0; qy < 6; qy++) if ((qx * 3 + qy * 5 + qx * qy) % 3 !== 1) g.fillRect(b[0] + b[2] * .05 + b[3] * (.02 + qx * .045), b[1] + b[3] * (.6 + qy * .045), b[3] * .036, b[3] * .036);
      g.fillStyle = "#2563eb"; rr(g, b[0] + b[2] * .44, b[1] + b[3] * .66, b[2] * .46, b[3] * .13, h * .02); g.fill();
    }
    if (mode === "qt") { b = appWindow(g, w, h, "QuickTime Player  ·  New Movie Recording", true); g.fillStyle = "#ff453a"; g.beginPath(); g.arc(b[0] + b[2] / 2, b[1] + b[3] * .9, b[3] * .045, 0, 7); g.fill(); }
    if (mode === "obs") {
      b = appWindow(g, w, h, "OBS Studio", true);
      g.fillStyle = "#232d44"; for (var k = 0; k < 4; k++) rr(g, b[0] + b[2] * (.04 + k * .235), b[1] + b[3] * .84, b[2] * .215, b[3] * .12, h * .012), g.fill();
    }
    if (mode === "rp") appWindow(g, w, h, "PS Remote Play", true);
    if (mode === "win sub") { b = appWindow(g, w, h, "PS Remote Play", true); subtitle(g, w, h, b[1] + b[3] * .72, Math.round(h * .06)); }
    s.tex.needsUpdate = true;
  }

  // ---------- name tags: real text over the canvas, so it stays sharp and readable at any size ----------
  var tags = {}, tagBox = null, reduce = false, onScreen = true;
  var TAG = { ps: "HDMI ของ PS5", cardIn: "HDMI IN", cardOut: "HDMI OUT", cardUsb: "USB", dongIn: "HDMI IN", dongUsb: "สาย USB ของการ์ด",
              splitIn: "IN", splitO1: "OUT 1", splitO2: "OUT 2", pcUsb: "USB ของคอม", padUsb: "USB ของจอย", pcHdmi: "HDMI ของคอม", tv1: "HDMI ของทีวี" };
  var OWNER = { ps: "d-ps", cardIn: "d-card", cardOut: "d-card", cardUsb: "d-card", dongIn: "d-dongle", dongUsb: "d-dongle", splitIn: "d-split", splitO1: "d-split", splitO2: "d-split", padUsb: "d-pad", pcUsb: "d-pc", pcHdmi: "d-pc", tv1: "d-tv" };
  function tag(id, text, at, cls) {
    var el = document.createElement("span"); el.className = "t3 " + cls; el.textContent = text; tagBox.appendChild(el);
    tags[id] = { el: el, at: at, show: false, hot: null };
  }
  function placeTags(want, hotOne) {
    var w = cv.clientWidth, h = cv.clientHeight, v = V(0, 0, 0);
    Object.keys(tags).forEach(function (id) {
      var t = tags[id], on = !!want[id];
      if (on) { v.copy(t.at).project(camera); on = v.z < 1 && Math.abs(v.x) < .97 && Math.abs(v.y) < .94; }
      if (on !== t.show) { t.show = on; t.el.style.opacity = on ? 1 : 0; }
      if (on) t.el.style.transform = "translate(" + Math.round((v.x * .5 + .5) * w) + "px," + Math.round((-v.y * .5 + .5) * h) + "px) translate(-50%,-120%)";
      var hot = on && hotOne === id;
      if (hot !== t.hot) { t.hot = hot; t.el.classList.toggle("hot", hot); }
    });
  }

  // ---------- init ----------
  S.init = function (canvas, overlay) {
    if (!T || !canvas) return false;
    try { renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true }); } catch (e) { return false; }
    cv = canvas; tagBox = overlay;
    var small = Math.min(window.innerWidth, window.innerHeight) < 600;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = small ? T.PCFShadowMap : T.PCFSoftShadowMap;
    scene = new T.Scene(); scene.fog = new T.Fog(0x0b1120, 24, 46);
    camera = new T.PerspectiveCamera(36, 16 / 10, .1, 100);
    scene.add(new T.HemisphereLight(0xdfe8ff, 0x1a2135, 1.05));
    var sun = new T.DirectionalLight(0xffffff, 1.25); sun.position.set(-6, 12, 9); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); var sc = sun.shadow.camera; sc.left = -12; sc.right = 12; sc.top = 10; sc.bottom = -8; sc.far = 40; scene.add(sun);
    var rim = new T.DirectionalLight(0x7fb0ff, .35); rim.position.set(6, 5, -10); scene.add(rim);
    var floor = new T.Mesh(new T.CircleGeometry(26, 48), new T.MeshStandardMaterial({ color: 0x0c1322, roughness: .95 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    var desk = rbox(15.5, .06, 9.5, .5, mat(0x2a3653, .85)); desk.position.set(-.2, .0, .2); desk.receiveShadow = true; scene.add(desk);

    devs["d-ps"] = buildPS5(); devs["d-card"] = buildCard(); devs["d-dongle"] = buildDongle(); devs["d-split"] = buildSplit();
    devs["d-pc"] = buildPC(); devs["d-tv"] = buildTV(); devs["d-phone"] = buildPhone(); devs["d-pad"] = buildPad();
    var names = { "d-ps": ["PS5", V(-5.5, 4.75, 0)], "d-card": ["การ์ดแคปเจอร์", V(0, .95, 2.2)], "d-dongle": ["การ์ดแคปเจอร์", V(0, .85, 2.2)],
                  "d-split": ["HDMI splitter", V(-3, .95, 2.6)], "d-pc": ["คอม", onPc(0, 2.75, 1.1)], "d-tv": ["ทีวี", V(0, 6.5, -2)], "d-phone": ["มือถือ", V(0, 1.45, -3.6)], "d-pad": ["จอย", V(1.9, .95, 4.3)] };
    Object.keys(devs).forEach(function (id) {
      devs[id].visible = false; scene.add(devs[id]);
      if (tagBox) tag(id, names[id][0], names[id][1], "name");
    });
    Object.keys(TAG).forEach(function (k) {
      if (tagBox) tag(k, TAG[k], PORT[k][0].clone().addScaledVector(PORT[k][1], .18).add(V(0, .34, 0)), "port");
      glow(k, PORT[k], k === "tv1");
    });
    cable("c-ps-card", "ps", "cardIn", HDMI); cable("c-ps-dong", "ps", "dongIn", HDMI);
    cable("c-card-tv", "cardOut", "tv1", HDMI);
    cable("c-card-pc", "cardUsb", "pcUsb", USB); cable("c-dong-pc", "dongUsb", "pcUsb", USB, true);
    cable("c-pad-pc", "padUsb", "pcUsb", USB); cable("c-ps-tv", "ps", "tv1", HDMI); cable("c-pc-tv", "pcHdmi", "tv1", HDMI);
    cable("c-ps-split", "ps", "splitIn", HDMI); cable("c-split-card", "splitO1", "dongIn", HDMI); cable("c-split-tv", "splitO2", "tv1", HDMI);
    air("a-rp", "d-ps", "d-pc"); air("a-tv", "d-pc", "d-tv"); air("a-phone", "d-pc", "d-phone");

    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fontOk = true; dirty = true; });
    window.addEventListener("resize", function () { dirty = true; });
    var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (mq) { reduce = mq.matches; (mq.addEventListener || function () {}).call(mq, "change", function (e) { reduce = e.matches; dirty = true; }); }
    if (window.IntersectionObserver) new IntersectionObserver(function (es) { onScreen = es[0].isIntersecting; dirty = true; }).observe(cv);   // nothing is drawn while the scene is out of view
    document.addEventListener("visibilitychange", function () { dirty = true; });
    ready = true; loop(); return true;
  };

  // which real cable a step's id means (the card kind decides both ends)
  var ENDS = { "c-ps-card": ["ps", "cardIn"], "c-ps-dong": ["ps", "dongIn"], "c-card-tv": ["cardOut", "tv1"], "c-card-pc": ["cardUsb", "pcUsb"], "c-dong-pc": ["dongUsb", "pcUsb"],
               "c-ps-tv": ["ps", "tv1"], "c-pad-pc": ["padUsb", "pcUsb"], "c-pc-tv": ["pcHdmi", "tv1"], "c-ps-split": ["ps", "splitIn"], "c-split-card": ["splitO1", "dongIn"], "c-split-tv": ["splitO2", "tv1"] };
  function real(id) {
    if (cfg.card === "one") { if (id === "c-ps-card") return "c-ps-dong"; if (id === "c-card-pc") return "c-dong-pc"; }
    return id;
  }
  S.configure = function (c) { cfg = c; shownStep = -1; Object.keys(cables).forEach(function (k) { cables[k].q = -1; }); dirty = true; };
  // The scene runs to where the reader is at this many steps a second, so a quick flick of the wheel
  // still shows the plug going in; far behind (a jump down the page) it catches up faster.
  var want = 0, lastT = 0, SPEED = 1.15, shownStep = -1;
  S.progress = function (f, jump) { want = f; if (jump) frac = f; dirty = true; };

  var SCREEN = { "s-tv": ["tv", "game"], "s-tv-sub": ["tv", "game sub"], "s-pc-app": ["pc", "app"], "s-pc": ["pc", "game sub"], "s-pc-rp": ["pc", "rp"], "s-pc-win": ["pc", "win sub"],
                 "s-pc-qt": ["pc", "qt"], "s-pc-obs": ["pc", "obs"], "s-phone": ["phone", "sub"] };
  var MENU = { "s-tv-hdcp": "menu-hdcp", "s-tv-rp": "menu-rp", "s-tv-install": "tv-install", "s-tv-wait": "tv-wait" };           // shown only during their own step
  function has(st, list) { return !!st && st.scr.some(function (s) { return list.indexOf(s) >= 0; }); }

  function pose(i) {                                    // camera position and target of step i
    var st = cfg.steps[i], narrow = cv.clientWidth / Math.max(1, cv.clientHeight) < 1.25 ? 1.22 : 1;
    var cab = st && st.on.map(real).filter(function (id) { return ENDS[id]; })[0];
    if (cab) {                                          // a cable: frame both of its sockets, from the side the far socket faces
      var A = PORT[ENDS[cab][0]], B = PORT[ENDS[cab][1]], mid = A[0].clone().lerp(B[0], .5), span = A[0].distanceTo(B[0]);
      mid.y = Math.max(.5, mid.y * .8);
      var dir = V(B[1].x * .55 + A[1].x * .2 - .08, 0, 1).normalize(), d = (5.4 + span * .95) * narrow;
      return [mid.clone().addScaledVector(dir, d * .86).add(V(0, d * .5, 0)), mid];
    }
    var ids = (st && st.focus.length ? st.focus : cfg.show).filter(function (d) { return CENTER[d]; });
    var c = V(0, 0, 0); ids.forEach(function (d) { c.add(CENTER[d]); }); c.multiplyScalar(1 / Math.max(1, ids.length));
    var spread = 0; ids.forEach(function (d) { spread = Math.max(spread, CENTER[d].distanceTo(c)); });
    var pcScreen = has(st, ["s-pc-app", "s-pc", "s-pc-qt", "s-pc-obs", "s-pc-rp", "s-pc-win"]) && ids.length === 1 && ids[0] === "d-pc";
    var front = has(st, ["s-pc", "s-tv-sub", "s-phone", "s-tv-hdcp", "s-tv-rp", "s-pc-win", "s-tv-install", "s-tv-wait"]);
    if (pcScreen) {                                     // look straight at the computer's screen, wherever it is turned
      var nrm = onPc(0, 0, -1).sub(PC_AT), tgt = onPc(0, 1.05, .3);
      return [tgt.clone().addScaledVector(nrm, 6.4 * narrow).add(V(0, 1.9, 0)), tgt];
    }
    var dist = ((front ? 12.4 : 7.6) + spread * 1.25) * narrow; c.y = Math.max(c.y * .7, .6);
    if (front) return [c.clone().add(V(-1.8, dist * .3, -dist * .98)), c];
    return [c.clone().add(V(-.6, dist * .52, dist * .92)), c];
  }
  function isFront(i) { var st = cfg.steps[i]; return has(st, ["s-pc", "s-tv-sub", "s-phone", "s-tv-hdcp", "s-tv-rp", "s-tv-install", "s-tv-wait", "s-pc-win", "s-pc-app", "s-pc-qt", "s-pc-obs", "s-pc-rp"]) && !st.on.some(function (id) { return ENDS[real(id)]; }); }

  function frame() {
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * renderer.getPixelRatio()) || cv.height !== Math.round(h * renderer.getPixelRatio())) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    var n = cfg.steps.length, i = Math.max(0, Math.min(n - 1, Math.floor(frac))), p = Math.max(0, Math.min(1, frac - i));
    if (frac >= n) { i = n - 1; p = 1; }
    if (i !== shownStep) { shownStep = i; if (cfg.onStep) cfg.onStep(i, n); }
    Object.keys(devs).forEach(function (id) { devs[id].visible = cfg.show.indexOf(id) >= 0; });
    if (S.usbA) { S.usbA.visible = !cfg.mac; S.usbC.visible = !!cfg.mac; }
    // A step's cable is plugged in over the FIRST part of the step, as its text comes up to the reading
    // line; by the time the reader is on the text the picture is finished and stays still.
    var prog = {}, hot = {}, mode = { tv: "off", pc: "off", phone: "off" }, wantTag = {}, hotOne = null, pulse = null;
    cfg.steps.forEach(function (st, k) {
      var q = k < i ? 1 : k === i ? Math.max(0, Math.min(1, p / .42)) : 0;
      st.on.forEach(function (id) {
        id = real(id); prog[id] = Math.max(prog[id] || 0, q);
        if (k !== i) return;
        hot[id] = 1;
        if (ENDS[id]) { wantTag[ENDS[id][0]] = wantTag[ENDS[id][1]] = 1; hotOne = q < .5 ? ENDS[id][0] : ENDS[id][1]; pulse = q < 1 ? hotOne : null; }
      });
      if (k < i || (k === i && p > .1)) st.scr.forEach(function (s) { if (SCREEN[s]) mode[SCREEN[s][0]] = SCREEN[s][1]; });
    });
    var here = cfg.steps[i];
    if (here && p > .1) here.scr.forEach(function (s) { if (MENU[s]) mode.tv = MENU[s] === "tv-install" ? (cfg.brand === "android" ? "tv-install-a" : "tv-install-o") : MENU[s]; });
    Object.keys(cables).forEach(function (id) { setCable(cables[id], prog[id] || 0, !!hot[id]); });
    var front = isFront(i);
    Object.keys(airs).forEach(function (id) { var a = airs[id]; a.g.visible = (prog[id] || 0) > .02 && !front; a.live = a.g.visible && !reduce; });
    Object.keys(glows).forEach(function (k) { glows[k].material.opacity = k === pulse ? (reduce ? .8 : .55 + .35 * Math.sin(performance.now() / 260)) : (wantTag[k] ? .35 : 0); });
    paintScreen("tv", mode.tv); paintScreen("pc", mode.pc); paintScreen("phone", mode.phone);
    // the camera holds this step's view, then goes to the next one over the last part of the step
    var a = pose(i), b = pose(Math.min(n - 1, i + 1)), t = Math.max(0, (p - .76) / .24); t = t * t * (3 - 2 * t);
    // go round the table, never through it: turn about the target, changing distance and height on the way
    var tg = a[1].clone().lerp(b[1], t), ra = a[0].clone().sub(a[1]), rb = b[0].clone().sub(b[1]);
    var aa = Math.atan2(ra.x, ra.z), ab = Math.atan2(rb.x, rb.z), da = ab - aa;
    if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    if (Math.abs(Math.abs(da) - Math.PI) < .6) da = -Math.abs(da);        // a half turn always goes the same way round
    var ang = aa + da * t, rad = Math.hypot(ra.x, ra.z) * (1 - t) + Math.hypot(rb.x, rb.z) * t;
    rad *= 1 + .18 * Math.sin(Math.PI * t) * Math.min(1, Math.abs(da));    // swing a little wide in the turn
    camera.position.set(tg.x + Math.sin(ang) * rad, tg.y + ra.y * (1 - t) + rb.y * t, tg.z + Math.cos(ang) * rad); camera.lookAt(tg);
    camera.updateMatrixWorld();
    var now = performance.now() / 1000;
    Object.keys(airs).forEach(function (id) { var a2 = airs[id]; if (!a2.g.visible) return; a2.dots.forEach(function (d, k) { d.position.copy(a2.curve.getPoint(((a2.live ? now * .35 : 0) + k / a2.dots.length) % 1)); }); });
    renderer.render(scene, camera);
    if (tagBox) {
      // a device's name steps aside while one of its sockets is being named
      // seen from the front, things behind the screen are out of sight: only name what the step is about
      (front && here && here.focus.length ? here.focus : cfg.show).forEach(function (id) { wantTag[id] = 1; });
      Object.keys(TAG).forEach(function (k) { if (wantTag[k]) delete wantTag[OWNER[k]]; });
      if (t > .05) Object.keys(TAG).forEach(function (k) { delete wantTag[k]; });
      placeTags(wantTag, hotOne);
    }
  }
  function loop(now) {
    raf = requestAnimationFrame(loop);
    var dt = Math.min(.1, ((now || 0) - lastT) / 1000); lastT = now || 0;
    if (!onScreen || document.hidden) return;
    if (Math.abs(want - frac) > .0005) {
      var d = want - frac, lim = SPEED * dt * (Math.abs(d) > 1.5 ? 4 : 1);
      frac += reduce || Math.abs(d) < lim ? d : (d > 0 ? lim : -lim); dirty = true;
    }
    var moving = !reduce && (Object.keys(airs).some(function (id) { return airs[id].live; }) || Object.keys(glows).some(function (k) { return glows[k].material.opacity > .5; }));
    if (dirty || moving) { dirty = false; frame(); }
  }
  window.Setup3D = S;
})();
