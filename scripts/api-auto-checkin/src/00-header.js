// ==UserScript==
// @name         签到助手
// @namespace    https://github.com/sunyu2481/userscripts
// @version      3.0.6
// @description  在页面上找到签到按钮并点击，一次点击依次处理多个站点。不调用任何接口，只代替你点按钮。
// @author       sunyu2481
// @match        https://*/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @noframes
// @updateURL    https://raw.githubusercontent.com/sunyu2481/userscripts/main/dist/api-auto-checkin.user.js
// @downloadURL  https://raw.githubusercontent.com/sunyu2481/userscripts/main/dist/api-auto-checkin.user.js
// ==/UserScript==

// 这个脚本不发任何网络请求：签到请求全部由站点页面自己发出，
// 脚本只是找到按钮、点一下，然后读页面的反馈。
(function () {
  'use strict';
