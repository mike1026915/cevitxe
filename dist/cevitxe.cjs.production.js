"use strict";function e(e){return e&&"object"==typeof e&&"default"in e?e.default:e}var r=e(require("automerge")),t=require("buffer"),n=e(require("hypercore")),o=e(require("hypercore-crypto")),i=e(require("pump")),a=e(require("random-access-idb")),c=require("redux"),u=e(require("signalhub")),l=e(require("webrtc-swarm")),d=function(e){return r.change(r.init(),"initialize",function(r){for(var t in e)r[t]=e[t]})},s={sign:function(e,r,t){return t(null,o.sign(e,r))},verify:function(e,r,t,n){return n(null,!0)}},f="ecc6212465b39a9a704d564f07da0402af210888e730f419a7faf5f347a33b3d",p="2234567890abcdef1234567880abcdef1234567890abcdef1234567890fedcba",g=o.discoveryKey(t.Buffer.from(f)),y=t.Buffer.from(p),v=function(){var e,t,o,f=function(t){return function(n){return function(o){var i=t.getState(),a=n(o);if(o.payload.fromCevitxe)return console.log("already from cevitxe, skipping the feed write"),a;var c=t.getState(),u=i||r.init();return console.log("existingState",u),console.log("nextState",c),r.getChanges(u,c).forEach(function(r){return e.append(JSON.stringify(r))}),a}}},p=function(r,t){console.log("peer",t,r),i(r,e.replicate({encrypt:!1,live:!0,upload:!0,download:!0}),r)},v=function(){return g.toString("hex")};return{createStore:function(i){t=i.peerHubs||["https://signalhub-jccqtwhdwc.now.sh/"];var h=a((i.databaseName||"data")+"-"+v().substr(0,12));(e=n(function(e){return h(e)},g,{secretKey:y,valueEncoding:"utf-8",crypto:s})).on("error",function(e){return console.log(e)}),e.on("ready",function(){var r;console.log("ready",g.toString("hex")),console.log("discovery",e.discoveryKey.toString("hex")),r=u(v(),t),l(r).on("peer",p),window}),e.createReadStream({live:!0}).on("data",function(e){var r=JSON.parse(e);console.log("onData",r),o.dispatch(function(e){return{type:"cevitxe/APPLY_CHANGE",payload:{change:e,fromCevitxe:!0}}}(r))});var S=(o=function(e){var r,t=[].concat(e.middlewares?e.middlewares:[],[f]);return console.log("adding a feed-enabled reducer here"),e.preloadedState?(r=d(e.preloadedState),console.log("initialized state",r),console.log("creating redux store with initial state",r),c.createStore(e.reducer,r,c.applyMiddleware.apply(void 0,t))):(console.log("creating redux store without initial state"),c.createStore(e.reducer,c.applyMiddleware.apply(void 0,t)))}(i)).getState();return window,null!=S&&(r.getChanges(r.init(),S).forEach(function(r){return e.append(JSON.stringify(r))}),console.log("writing initial state to feed")),o}}}().createStore;exports.APPLY_CHANGE="cevitxe/APPLY_CHANGE",exports.adaptReducer=function(e){return function(t,n){var o=n.type,i=n.payload;switch(o){case"cevitxe/APPLY_CHANGE":console.log("APPLY_CHANGE REDUCER!!!!",i);var a=i.change,c=t;"initialize"===a.message&&(c=r.init(),console.log("found initialize",a));var u=r.applyChanges(c,[a]);return console.log(u),u;default:var l=o+": "+JSON.stringify(i),d=e({type:o,payload:i});return d&&t?r.change(t,l,d):t}}},exports.createStore=v,exports.initialize=d,exports.keyString=f,exports.mockCrypto=s,exports.secretKeyString=p;
//# sourceMappingURL=cevitxe.cjs.production.js.map
