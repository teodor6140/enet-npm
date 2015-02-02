;
(function () {

	"use strict";

	var Buffer = require("buffer").Buffer;
	var events = require("events");
	var util = require("util");
	var Stream = require("stream");
	var ENETModule = require("../build/enet.js");

	var jsapi_ = ENETModule.jsapi;
	var enet_ = ENETModule.libenet;

	var ENET_HOST_SERVICE_INTERVAL = 10; //milliseconds

	var enet = module.exports = {
		Host: ENetHost,
		Address: ENetAddress,
		Packet: ENetPacket,
		inet_ip2long: ip2long,
		inet_long2ip: long2ip,
		Buffer: Buffer, //for use in chrome app when creating packets
	};

	util.inherits(ENetHost, events.EventEmitter);
	util.inherits(ENetPeer, events.EventEmitter);
	util.inherits(ENetPacket, events.EventEmitter);

	enet.init = function (func) {
		var funcPointer = ENETModule["Runtime_addFunction"](function (host_ptr) {
			var addr = new ENetAddress(jsapi_.host_get_receivedAddress(host_ptr));
			return func(addr.address(), addr.port());
		});
		jsapi_.init(funcPointer);
	};

	enet.PACKET_FLAG = {
		RELIABLE: 1,
		UNSEQUENCED: 1 << 1,
		UNRELIABLE_FRAGMENT: 1 << 3
	};

	enet.PEER_STATE = {
		DISCONNECTED: 0,
		CONNECTING: 1,
		ACKNOWLEDGING_CONNECT: 2,
		CONNECTION_PENDING: 3,
		CONNECTION_SUCCEEDED: 4,
		CONNECTED: 5,
		DISCONNECT_LATER: 6,
		DISCONNECTING: 7,
		ACKNOWLEDGING_DISCONNECT: 8,
		ZOMBIE: 9
	};

	process.removeAllListeners("uncaughtException"); //emscripten catches and throws again!
	process.on("uncaughtException", function (e) {
		//catch uncaught exceptions
		// node's .bind() on dgram sockets throws an async exception
		// it will be caught in socket.on("error") in createHost();
		// but we catch the exception here to prevent app crashing
		console.error("uncaught exception:", e);
	});

	function createHost(arg, callback, host_type) {
		var host, socket;
		var opt = {};

		if (typeof arg === "function") {
			callback = arg;
		} else {
			opt = arg || opt;
		}

		callback = callback || function () {};
		try {
			host = new ENetHost(opt.address, opt.peers, opt.channels, opt.down, opt.up, host_type, opt.socket);

			if (!host || host._pointer === 0) {
				callback(new Error("host-creation-error"));
				return undefined;
			}

			socket = host._socket;

			if (!socket) {
				callback(new Error("socket-creation-error"));
				return undefined;
			}

			//catch socket bind errors
			socket.on("error", function (e) {
				host._socket_closed = true;

				//server will bind so error will be called before listening if error occurs
				//so we can return the error in the callback
				if (host_type === "server") {
					callback(e);
				} else {
					//for client and custom host application can listen for the error event
					host.emit("error", e);
				}

				host.destroy();
			});

			socket.on("close", function () {
				host._socket_closed = true;
				host.destroy();
			});

			socket.on("listening", function () {
				socket.setBroadcast(true);
				//for server host callback when socket is listening
				if (host_type === "server" && typeof callback === 'function') callback(undefined, host);
			});

			//bind the socket
			if (host_type !== "client") jsapi_.enet_host_bind(host._pointer);

			if (host_type === "client" && typeof callback === 'function') {
				setTimeout(function () {
					callback(undefined, host); //clients get host in callback before socket is listening.
				});
			}

			return host;

		} catch (e) {
			if (typeof callback === 'function') callback(e);
		}
	}

	enet.createServer = function (arg, callback) {
		return createHost(arg, callback, "server");
	};

	enet.createClient = function (arg, callback) {
		return createHost(arg, callback, "client");
	};

	enet.createServerFromSocket = function (arg, callback) {
		return createHost(arg, callback, "custom");
	};

	function ENetHost(address, maxpeers, maxchannels, bw_down, bw_up, host_type, custom_socket) {
		events.EventEmitter.call(this);
		this.setMaxListeners(0);
		this.connectedPeers = {};
		var enetAddr;
		var self = this;
		var pointer = 0;
		var socketfd, stream;

		switch (host_type) {
		case "client":
			this._type = "client";
			pointer = jsapi_.enet_host_create_client(maxpeers || 128, maxchannels || 5, bw_down || 0, bw_up ||
				0);
			break;

		case "custom":
			this._type = "custom";
			//insert a socket into emscrtipten FS
			socketfd = ENETModule["createStreamFromSocket"](custom_socket);
			pointer = jsapi_.enet_host_from_socket(socketfd, 0, maxpeers || 128, maxchannels || 5, bw_down ||
				0,
				bw_up ||
				0);
			break;

		case "server":
			this._type = "server";
			address = address || {
				address: "0.0.0.0",
				port: 0
			};
			enetAddr = (address instanceof ENetAddress) ? address : new ENetAddress(address);
			pointer = jsapi_.enet_host_create_server(enetAddr.host(), enetAddr.port(), maxpeers || 128,
				maxchannels ||
				5,
				bw_down || 0,
				bw_up || 0);
			break;

		default:
			//create a host using the createClient and createServer methods.
			throw (new Error(
				"Do not create a new instance of enet.Host. Use enet.createServer() and enet.createClient() instead."
			));
		}

		if (pointer === 0) {
			throw ('failed to create ENet host');
		}

		self._event = new ENetEvent(); //allocate memory for events - free it when we destroy the host
		self._pointer = pointer;
		socketfd = jsapi_.host_get_socket(self._pointer);
		self._socket = ENETModule["getStreamSocket"](socketfd);
	}

	ENetHost.prototype.isOffline = function () {
		return (typeof this._pointer === "undefined" || this._pointer === 0 || this._shutting_down || this._socket_closed);
	};

	ENetHost.prototype.isOnline = function () {
		return (this.isOffline() === false);
	};

	ENetHost.prototype._service = function () {
		var self = this;
		var peer;
		var recvdAddr;
		if (self._servicing) return;
		self._servicing = true;

		if (!self._pointer || !self._event || self._socket_closed) return;
		var err = enet_.host_service(self._pointer, self._event._pointer, 0);
		while (err > 0) {

			switch (self._event.type()) {
			case 1: //connect
				peer = self.connectedPeers[self._event.peerPtr()];
				if (peer) {
					//outgoing connection
					peer.emit("connect");
					self.emit("connect",
						peer,
						undefined,
						true //local host initiated the connection to foriegn host
					);
				} else {
					peer = self.connectedPeers[self._event.peerPtr()] = self._event.peer();
					peer._host = self;
					//incoming connection
					self.emit("connect",
						peer,
						self._event.data(),
						false //foreign host initiated connection to local host
					);
				}
				break;
			case 2: //disconnect
				peer = self.connectedPeers[self._event.peerPtr()];
				if (peer) {
					delete self.connectedPeers[self._event.peerPtr()];
					peer._pointer = 0;
					peer.emit("disconnect", self._event.data());
				}
				break;
			case 3: //receive
				peer = self.connectedPeers[self._event.peerPtr()] || self._event.peer();
				self.emit("message",
					peer,
					self._event.packet(),
					self._event.channelID()
				);
				peer.emit("message", self._event.packet(), self._event.channelID());
				self._event.packet().destroy();
				break;
			case 100: //JSON,telex
				recvdAddr = self.receivedAddress();
				self.emit("telex",
					self._event.packet().data(), {
						'address': recvdAddr.address,
						'port': recvdAddr.port
					}
				);
				self._event.packet().destroy();
				break;
			}
			if (!self._pointer || !self._event || self._socket_closed) return;

			err = enet_.host_service(self._pointer, self._event._pointer, 0);
		}
		if (err < 0) console.error("Error servicing host: ", err);
		self._servicing = false;
	};

	ENetHost.prototype.destroy = function () {
		var self = this;
		var peer, peer_ptr;
		if (self._shutting_down) return;
		self._shutting_down = true;

		if (self._io_loop) {
			clearInterval(self._io_loop);
		}

		if (typeof self._pointer === 'undefined' || self._pointer === 0) return;

		for (peer_ptr in self.connectedPeers) {
			peer = self.connectedPeers[peer_ptr];
			if (peer && peer._pointer !== 0) {
				if (!self._socket_closed) enet_.peer_disconnect_now(peer_ptr, 0);
				peer._pointer = 0;
				peer.emit("disconnect", 0);
			}
		}
		delete self.connectedPeers;
		self.flush();

		if (self._event) self._event.free();

		try {
			if (self._pointer) enet_.host_destroy(self._pointer);
		} catch (e) {}

		delete self._pointer;
		delete self._event;
		delete self._io_loop;
		delete self._socket;
		self.emit("destroy");
	};

	ENetHost.prototype.stop = ENetHost.prototype.destroy;

	ENetHost.prototype.receivedAddress = function () {
		if (this.isOffline()) return;
		var ptr = jsapi_.host_get_receivedAddress(this._pointer);
		var addr = new ENetAddress(ptr);
		return ({
			address: addr.address(),
			port: addr.port()
		});
	};

	ENetHost.prototype.address = function () {
		if (this.isOffline()) return;
		return this._socket.address();
	};

	ENetHost.prototype.send = function (ip, port, buff, callback) {
		if (this.isOffline()) return;
		this._socket.send(buff, 0, buff.length, port, ip, callback);
	};

	ENetHost.prototype.flush = function () {
		if (this.isOffline()) return;
		enet_.host_flush(this._pointer);
	};

	ENetHost.prototype.connect = function (address, channelCount, data, callback) {
		if (this.isOffline()) {
			if (typeof callback === 'function') callback(new Error("host-destroyed"));
			return;
		}

		var self = this;
		var peer;
		var enetAddr = (address instanceof ENetAddress) ? address : new ENetAddress(address);
		var ptr = jsapi_.enet_host_connect(this._pointer, enetAddr.host(), enetAddr.port(), channelCount || 5,
			data ||
			0);

		self.firstStart(); //start servicing if not yet started

		var succeeded = false;
		if (ptr) {
			peer = new ENetPeer(ptr);
			peer._host = self;
			self.connectedPeers[ptr] = peer;
			if (typeof callback === 'function') {
				peer.on("connect", function () {
					succeeded = true;
					callback(undefined, peer);
				});
				peer.on("disconnect", function () {
					if (!succeeded) callback(new Error("failed"));
				});
			}
			return peer;
		} else {
			//ptr is NULL - number of peers exceeded
			if (typeof callback === 'function') {
				callback(new Error("maxpeers"));
				return undefined;
			}
		}
	};

	ENetHost.prototype.throttleBandwidth = function () {
		if (this.isOffline()) return;
		enet_.host_bandwidth_throttle(this._pointer);
		return this;
	};

	ENetHost.prototype.enableCompression = function () {
		if (this._pointer) {
			enet_.host_compress_with_range_coder(this._pointer);
		}
		return this;
	};

	ENetHost.prototype.disableCompression = function () {
		if (this._pointer) {
			enet_.host_compress(this._pointer, 0); //passing a 0 disables compression
		}
		return this;
	};

	ENetHost.prototype.broadcast = function (channel, packet) {
		if (this.isOffline()) return;

		if (packet instanceof Buffer) packet = new ENetPacket(packet, enet.PACKET_FLAG.RELIABLE);

		enet_.host_broadcast(this._pointer, channel, packet._pointer);
	};

	ENetHost.prototype.peers = function () {
		var peer, peer_ptr, peers = [];
		for (peer_ptr in this.connectedPeers) {
			peers.push(this.connectedPeers[peer_ptr]);
		}
		return peers;
	};

	ENetHost.prototype.firstStart = function () {
		var self = this;
		if (!self._io_loop) {
			self._io_loop = setInterval(function () {
				self._service();
			}, ENET_HOST_SERVICE_INTERVAL);
		}
	};

	ENetHost.prototype.start = function (ms_interval) {
		var self = this;
		if (!self._pointer) return; //cannot start a host that is not initialised
		if (self._io_loop) {
			clearInterval(this._io_loop);
		}
		self._io_loop = setInterval(function () {
			self._service();
		}, ms_interval || ENET_HOST_SERVICE_INTERVAL);
	};

	function ENetPacket() {
		var packet = this;

		var buf, flags, callback;

		//packet from pointer
		if (arguments.length === 1 && typeof arguments[0] === 'number') {
			packet._pointer = arguments[0];
			return packet;
		}

		//packet from buffer
		if (arguments.length > 0 && typeof arguments[0] === 'object') {
			//construct a new packet from node buffer
			buf = arguments[0];

			if (typeof arguments[1] === 'function') {
				callback = arguments[1];
			}
			if (typeof arguments[1] === 'number') {
				flags = arguments[1];
			}
			if (arguments.length === 3 && typeof arguments[2] === 'function') {
				callback = arguments[2];
			}
			flags = flags || 0;

			packet._packetFromBuffer(buf, flags);

			if (callback) {
				packet._attachFreeCallback(callback);
			}

			return packet;
		}

		//packet from string
		if (arguments.length > 0 && typeof arguments[0] == 'string') {
			return new ENetPacket(new Buffer(arguments[0]), arguments[1], arguments[2]);
		}
	}

	ENetPacket.prototype._packetFromBuffer = function (buf, flags) {
		var packet = this;
		packet._pointer = enet_.packet_create(0, buf.length, flags);
		var begin = jsapi_.packet_get_data(packet._pointer);
		var end = begin + buf.length;
		var c = 0,
			i = begin;
		for (; i < end; i++, c++) {
			ENETModule["HEAPU8"][i] = buf.readUInt8(c);
		}
	};

	ENetPacket.prototype._attachFreeCallback = function (callback) {
		if (typeof callback !== 'function') return;
		var packet = this;
		if (packet._free_ptr) {
			ENETModule["Runtime_removeFunction"](packet._free_ptr);
		}
		packet._free_ptr = ENETModule["Runtime_addFunction"](function (p) {
			callback();
			ENETModule["Runtime_removeFunction"](packet._free_ptr);
			packet._free_ptr = 0;
		});
		jsapi_.packet_set_free_callback(packet._pointer, packet._free_ptr);
	};

	ENetPacket.prototype.data = function () {
		var begin = jsapi_.packet_get_data(this._pointer);
		var end = begin + jsapi_.packet_get_dataLength(this._pointer);
		return new Buffer(ENETModule["HEAPU8"].subarray(begin, end), "byte");
		//return HEAPU8.subarray(begin,end);
	};
	ENetPacket.prototype.dataLength = function () {
		return jsapi_.packet_get_dataLength(this._pointer);
	};
	ENetPacket.prototype.destroy = function () {
		enet_.packet_destroy(this._pointer);
		this._pointer = 0;
	};

	function ENetEvent() {
		this._pointer = jsapi_.event_new();
	}

	ENetEvent.prototype.free = function () {
		jsapi_.event_free(this._pointer);
	};

	ENetEvent.prototype.type = function () {
		return jsapi_.event_get_type(this._pointer);
	};
	ENetEvent.prototype.peer = function () {
		var ptr = jsapi_.event_get_peer(this._pointer);
		return new ENetPeer(ptr);
	};
	ENetEvent.prototype.peerPtr = function () {
		return jsapi_.event_get_peer(this._pointer);
	};
	ENetEvent.prototype.packet = function () {
		var ptr = jsapi_.event_get_packet(this._pointer);
		return new ENetPacket(ptr);
	};
	ENetEvent.prototype.data = function () {
		return jsapi_.event_get_data(this._pointer);
	};
	ENetEvent.prototype.channelID = function () {
		return jsapi_.event_get_channelID(this._pointer);
	};

	function ENetAddress() {
		if (arguments.length == 1 && typeof arguments[0] == 'object') {
			if (arguments[0] instanceof ENetAddress) {
				this._host = arguments[0].host();
				this._port = arguments[0].port();
			} else {
				this._host = ip2long((arguments[0]).address || 0);
				this._port = parseInt(arguments[0].port || 0);
			}
			return this;
		}
		if (arguments.length == 1 && typeof arguments[0] == 'number') {
			this._pointer = arguments[0];
			return this;
		}
		if (arguments.length == 1 && typeof arguments[0] == 'string') {
			var ipp = arguments[0].split(':');
			this._host = ip2long(ipp[0]);
			this._port = parseInt(ipp[1] || 0);
			return this;
		}
		if (arguments.length == 2) {
			if (typeof arguments[0] == 'string') {
				this._host = ip2long((arguments[0]));
			} else {
				this._host = arguments[0];
			}
			this._port = parseInt(arguments[1]);
			return this;
		}
		throw ("bad parameters creating ENetAddress");
	}

	ENetAddress.prototype.host = function () {
		if (this._pointer) {
			var hostptr = jsapi_.address_get_host(this._pointer);
			return ENETModule["HEAPU32"][hostptr >> 2];
		} else {
			return this._host;
		}
	};
	ENetAddress.prototype.port = function () {
		if (this._pointer) {
			return jsapi_.address_get_port(this._pointer);
		} else {
			return this._port;
		}
	};
	ENetAddress.prototype.address = function () {
		if (this._pointer) return long2ip(this.host(), 'ENetAddress.prototype.address from pointer');
		return long2ip(this.host(), 'ENetAddress.prototype.address from local');
	};

	function ENetPeer(pointer) {
		if (pointer) this._pointer = pointer;
		else throw ("ENetPeer null pointer");
		events.EventEmitter.call(this);
		this.setMaxListeners(0);
	}

	ENetPeer.prototype.state = function () {
		if (this._pointer) {
			return jsapi_.peer_get_state(this._pointer);
		}
		return enet.PEER_STATE.DISCONNECTED;
	};

	ENetPeer.prototype.incomingDataTotal = function () {
		if (this._pointer) {
			return jsapi_.peer_get_incomingDataTotal(this._pointer);
		}
		return 0;
	};

	ENetPeer.prototype.outgoingDataTotal = function () {
		if (this._pointer) {
			return jsapi_.peer_get_outgoingDataTotal(this._pointer);
		}
		return 0;
	};

	ENetPeer.prototype.send = function (channel, packet, callback) {
		var peer = this;
		if (peer._host.isOffline()) {
			if (typeof callback === 'function') callback(new Error("host-destroyed"));
			return peer;
		}

		if (!peer._pointer) {
			if (typeof callback === 'function') callback(new Error("Peer is disconnected"));
			return peer;
		}

		if (!(packet instanceof ENetPacket)) packet = new ENetPacket(packet, enet.PACKET_FLAG.RELIABLE);

		if (typeof callback === 'function') {
			packet._attachFreeCallback(callback);
		}

		if (enet_.peer_send(peer._pointer, channel, packet._pointer) !== 0) {
			if (typeof callback === 'function') callback(new Error('Packet not queued'));
			return true; //packet not queued - error
		}

		return false; //packed queued - no error
	};

	ENetPeer.prototype._delete = function (emitDisconnect) {
		var peer = this;
		if (!peer._pointer) return;
		if (peer._host) delete peer._host.connectedPeers[peer._pointer];
		peer._pointer = 0;
		if (emitDisconnect) peer.emit("disconnect");
	};

	ENetPeer.prototype.reset = function () {
		var peer = this;
		if (peer._pointer) {
			enet_.peer_reset(this._pointer);
			peer._delete(false);
		}
		return peer;
	};
	ENetPeer.prototype.ping = function () {
		var peer = this;
		if (peer._pointer) enet_.peer_ping(peer._pointer);
		return peer;
	};
	ENetPeer.prototype.disconnect = function (data) {
		var peer = this;
		if (peer._pointer) {
			enet_.peer_disconnect(peer._pointer, data || 0);
			//peer._delete(false);
		}
		return peer;
	};
	ENetPeer.prototype.disconnectNow = function (data) {
		var peer = this;
		if (peer._pointer) {
			enet_.peer_disconnect_now(peer._pointer, data || 0);
			peer._delete(true);
		}
		return peer;
	};
	ENetPeer.prototype.disconnectLater = function (data) {
		var peer = this;
		if (peer._pointer) {
			enet_.peer_disconnect_later(peer._pointer, data || 0);
			//peer._delete(false);
		}
		return peer;
	};
	ENetPeer.prototype.address = function () {
		var peer = this;
		if (!peer._pointer) {
			if (peer._address) return peer._address;
			return;
		}
		var ptr = jsapi_.peer_get_address(peer._pointer);
		var addr = new ENetAddress(ptr);
		//save the address so we can check it after disconnect
		peer._address = {
			address: addr.address(),
			port: addr.port()
		};
		return peer._address;
	};

	//turn a channel with peer into a node writeable Stream
	// ref: https://github.com/substack/stream-handbook
	ENetPeer.prototype.createWriteStream = function (channel) {
		var peer = this;
		if (!peer._pointer) return;

		var connected = (peer.state() === enet.PEER_STATE.CONNECTED);
		var error = false;

		var s = new Stream.Writable();

		peer.on("connect", function () {
			connected = true;
		});

		peer.on("disconnect", function (data) {
			connected = false;
		});

		s._write = function (buf, enc, next) {
			if (!connected) {
				next("peer-not-connected");
				return;
			}

			if (error) {
				next("packet-queuing-error");
				return;
			}

			var packet = new ENetPacket(buf, enet.PACKET_FLAG.RELIABLE);

			error = peer.send(channel, packet);

			if (error) {
				next("packet-queuing-error");
				return;
			}

			next();
		};

		return s;
	};

	ENetPeer.prototype.createReadStream = function (channel) {
		var peer = this;
		if (!peer._pointer) return;

		var s = new Stream.Readable();

		var connected = (peer.state() === enet.PEER_STATE.CONNECTED);

		peer.on("connect", function () {
			connected = true;
		});

		peer.on("disconnect", function (data) {
			connected = false;
			s.push(null); //signals end of data
		});

		peer.on("message", function (_packet, _channel) {
			if (channel === _channel) {
				s.push(_packet.data());
			}
		});

		s._read = function (size) {
			if (!connected) s.push(null);
		};

		return s;

	};

	ENetPeer.prototype.createDuplexStream = function (channel) {
		var peer = this;
		if (!peer._pointer) return;

		var s = new Stream.Duplex();
		var error = false;

		var connected = (peer.state() === enet.PEER_STATE.CONNECTED);

		peer.on("connect", function () {
			connected = true;
		});

		peer.on("disconnect", function (data) {
			connected = false;
			s.push(null); //signals end of data
		});

		s._write = function (buf, enc, next) {
			if (!connected) {
				next("peer-not-connected");
				return;
			}

			if (error) {
				next("packet-queuing-error");
				return;
			}

			var packet = new ENetPacket(buf, enet.PACKET_FLAG.RELIABLE);

			error = peer.send(channel, packet);

			if (error) {
				next("packet-queuing-error");
				return;
			}

			next();
		};

		peer.on("message", function (_packet, _channel) {
			if (channel === _channel) {
				s.push(_packet.data());
			}
		});

		s._read = function (size) {
			if (!connected) s.push(null);
		};

		return s;
	};


	function ip2long(ipstr) {
		var b = ipstr.split('.');
		return (Number(b[0]) | (Number(b[1]) << 8) | (Number(b[2]) << 16) | (Number(b[3]) << 24)) >>> 0;
	}

	function long2ip(addr) {
		return (addr & 0xff) + '.' + ((addr >> 8) & 0xff) + '.' + ((addr >> 16) & 0xff) + '.' + ((addr >> 24) &
			0xff);
	}

}).call(this);