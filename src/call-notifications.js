'use strict';
// Electron notification action buttons are not a portable Linux API: use the desktop's D-Bus service.
class CallNotifications {
  constructor({ icon, onAction, onFailure, connect }) {
    this.icon = icon; this.onAction = onAction; this.onFailure = onFailure;
    this.connect = connect || (() => require('dbus-next').sessionBus());
    this.generation = 0;
  }
  async service() {
    if (this.iface) return this.iface;
    if (!this.pending) this.pending = (async () => {
      this.bus = this.connect();
      this.bus.on('error', () => { this.iface = null; this.pending = null; });
      const proxy = await this.bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications');
      const iface = proxy.getInterface('org.freedesktop.Notifications');
      iface.on('ActionInvoked', (id, action) => {
        if (id !== this.notificationId || !this.callId || !['accept','decline'].includes(action)) return;
        const call = this.callId;
        this.onAction(action, call);
        this.close();
      });
      iface.on('NotificationClosed', id => { if (id === this.notificationId) { this.notificationId = null; } });
      this.iface = iface;
      return iface;
    })().catch(error => { this.pending = null; throw error; });
    return this.pending;
  }
  async show(callId) {
    if (this.callId === callId) return;
    this.close(); this.callId = callId;
    const generation = this.generation;
    try {
      const iface = await this.service();
      const caps = await iface.GetCapabilities();
      if (generation !== this.generation) return;
      const actions = caps.includes('actions') ? ['accept','Accept','decline','Decline'] : [];
      const { Variant } = require('dbus-next');
      const id = await iface.Notify('WhatsApp', 0, this.icon, 'Incoming WhatsApp call', actions.length ? 'Incoming call' : 'Open WhatsApp to answer this call.', actions, { urgency: new Variant('y', 2), 'desktop-entry': new Variant('s', 'whatsapp-linux') }, 45000);
      if (generation !== this.generation) { await iface.CloseNotification(id); return; }
      this.notificationId = id;
      this.timer = setTimeout(() => this.close(), 45000);
    } catch (_) { if (generation === this.generation) this.fail('Call notification controls unavailable. Open WhatsApp to answer.'); }
  }
  fail(message) { this.close(); this.onFailure(message); }
  close() {
    this.generation++;
    clearTimeout(this.timer);
    const id = this.notificationId;
    this.notificationId = null; this.callId = null;
    if (id && this.iface) this.iface.CloseNotification(id).catch(() => {});
  }
}
module.exports = { CallNotifications };
