/**
 * LMS-Material
 *
 * Copyright (c) 2018-2019 Craig Drummond <craig.p.drummond@gmail.com>
 * MIT license.
 */

var lmsServerAddress = "";
var lmsLastScan = undefined;
var haveLocalAndroidPlayer = false;

var currentIpAddress = undefined;
var RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
if (RTCPeerConnection)(function() {
    var rtc = new RTCPeerConnection({iceServers:[]});
    rtc.createDataChannel('', {reliable: false});
    rtc.onicecandidate = function(evt) {
        if (evt.candidate) {
            grepSdp(evt.candidate.candidate);
        }
    };

    rtc.createOffer(function(offerDesc) {
        rtc.setLocalDescription(offerDesc);
    }, function(e) { console.warn("Failed to get IP address", e); });

    function grepSdp(sdp) {
        var ip = /(192\.168\.(0|\d{0,3})\.(0|\d{0,3}))/i;
        sdp.split('\r\n').forEach(function(line) {
            if (line.match(ip)) {
                currentIpAddress = line.match(ip)[0];
            }
        });
    }
})();


function lmsCheckConnection() {
    var url = (lmsServerAddress.length>0 ? lmsServerAddress + "/material/" : "") + "html/css/blank.css?r"+(new Date().getTime());
    return axios({ method: "get", url: url, timeout: 1000});
}

function lmsCommand(playerid, command) {
    var args = {
            method: "post",
            url: lmsServerAddress+"/jsonrpc.js",
            headers: {'Content-Type': 'text/plain'},
            data: {
                id: 1,
                method: "slim.request",
                params: [playerid, command]
           }};
    if (debug && command && command.length>0 && command[0]!="status" && command[0]!="serverstatus") {
        logJsonMessage("REQ", args.data.params);
    }
    return axios(args);
}

function lmsList(playerid, command, params, start, batchSize, cancache) {
    var cmdParams = command.slice();
    cmdParams = [].concat(cmdParams, [start, undefined===batchSize ? LMS_BATCH_SIZE : batchSize]);
    if (params && params.length>0) {
        cmdParams = [].concat(cmdParams, params);
    }
    if (cancache) {
        try {
            var key = cacheKey(command, params, start, batchSize);
            var entry = getLocalStorageVal(key, undefined);

            if (undefined!=entry) {
                var cache = JSON.parse(entry);
                // Return promise!
                return new Promise(function(resolve, reject) {
                    resolve({data:cache});
                });
            }
        }  catch(e) {
            logError(e);
        }
    }
    return lmsCommand(playerid, cmdParams)   
}

var lmsServer = Vue.component('lms-server', {
    template: `<div/>`,
    data() {
        return {
        };
    },
    methods: {
        scheduleNextStatusUpdate: function(nextInterval) {
            // Schedule next timer
            this.statusRefreshTimer = setTimeout(function () {
                this.refreshStatus();
            }.bind(this), nextInterval);
        },
        setServerStatusUpdateInterval: function(interval) {
            if (interval == this.currentServerStatusInterval) {
                return;
            }
            if (undefined!==this.serverStatusRefreshInterval) {
                clearInterval(this.serverStatusRefreshInterval);
                this.serverStatusRefreshInterval = undefined;
            }
            this.currentServerStatusInterval = interval;
            this.serverStatusRefreshInterval = setInterval(function () {
                this.refreshServerStatus();
            }.bind(this), interval);
        },
        refreshServerStatus: function () {
            if (this.$store.state.noNetwork) {
                this.setServerStatusUpdateInterval(1000);
                return;
            }

            //console.log("Refresh");
            lmsCommand("", ["serverstatus", 0, LMS_MAX_PLAYERS]).then(({data}) => {
                var players = [];
                if (lmsLastScan!=data.result.lastscan) {
                    lmsLastScan = data.result.lastscan;
                    clearListCache();
                }
                if (data && data.result && data.result.players_loop) {
                    var localAndroidPlayer = false;
                    data.result.players_loop.forEach(i => {
                        if (1===i.connected) {
                            players.push({ id: i.playerid,
                                           name: i.name,
                                           canpoweroff: 1===i.canpoweroff,
                                           ison: 1===i.power,
                                           isconnected: 1===i.connected,
                                           isgroup: 'group'===i.model
                                          });
                            // Check if we have a local SB Player - if so, can't use MediaSession
                            if (!localAndroidPlayer && currentIpAddress && 'SB Player' ===i.modelname && i.ip.split(':')[0] == currentIpAddress) {
                                localAndroidPlayer = true;
                            }
                        }
                    });
                    if (localAndroidPlayer != haveLocalAndroidPlayer) {
                        haveLocalAndroidPlayer = localAndroidPlayer;
                        if (haveLocalAndroidPlayer) {
                            bus.$emit('haveLocalAndroidPlayer');
                        }
                    }
                    this.$store.commit('setPlayers', players.sort(function(a, b) {
                                                                        if (a.isgroup!=b.isgroup) {
                                                                            return a.isgroup ? -1 : 1;
                                                                        }
                                                                        var nameA = a.name.toUpperCase();
                                                                        var nameB = b.name.toUpperCase();
                                                                        if (nameA < nameB) {
                                                                            return -1;
                                                                        }
                                                                        if (nameA > nameB) {
                                                                            return 1;
                                                                        }
                                                                        return 0;
                                                                   }));
                }
                this.setServerStatusUpdateInterval(players.length>0 ? LMS_SERVER_STATUS_REFRESH_MAX : LMS_SERVER_STATUS_REFRESH_MIN);
            }).catch(err => {
                if (!err.response) {
                    // If this is a network error, check if connection is up...
                    var that = this;
                    lmsCheckConnection().then(function (resp) {
                        that.setServerStatusUpdateInterval(500);
                     }).catch(err => {
                        bus.$emit('noNetwork');
                    });
                } else {
                    logError(err);
                    this.setServerStatusUpdateInterval(LMS_STATUS_REFRESH_MIN);
                }
            });
        },
        refreshStatus: function() {
            if (undefined!==this.statusRefreshTimer) {
                clearTimeout(this.statusRefreshTimer);
            }
            if (this.$store.state.noNetwork) {
                this.scheduleNextStatusUpdate(1000);
                return;
            }
            var nextInterval = LMS_STATUS_REFRESH_MAX;
            if (this.$store.state.players && this.$store.state.players.length>0 && this.$store.state.player.id) {
                lmsCommand(this.$store.state.player.id, ["status", "-", 1, "tags:cdeloyrstAKNS"]).then(({data}) => {
                    var nextInterval = LMS_STATUS_REFRESH_MAX;
                    if (data && data.result) {
                        var player = { ison: data.result.power,
                                       isplaying: data.result.mode === "play" && !data.result.waitingToPlay,
                                       volume: -1,
                                       playlist: { shuffle:0, repeat: 0, duration:0, name:'', current: -1, count:0, timestamp:0},
                                       current: { canseek: 0, time: 0, duration: 0 },
                                       will_sleep_in: data.result.will_sleep_in,
                                       synced: data.result.sync_master || data.result.sync_slaves
                                     };

                        player.volume = undefined==data.result["mixer volume"] ? 0 : Math.round(data.result["mixer volume"]);
                        // Store volume, so that it can be accessed in 'adjustVolume' handler
                        this.volume = player.volume;
                        player.playlist = { shuffle: data.result["playlist shuffle"],
                                            repeat: data.result["playlist repeat"],
                                            duration: data.result["playlist duration"],
                                            name: data.result.playlist_name,
                                            current: undefined==data.result.playlist_cur_index ? -1 : parseInt(data.result.playlist_cur_index),
                                            count: data.result.playlist_tracks,
                                            timestamp: undefined===data.result.playlist_timestamp ? 0 : data.result.playlist_timestamp
                                          };
                        if (data.result.playlist_loop && data.result.playlist_loop.length>0) {
                            player.current = data.result.playlist_loop[0];
                            player.current.time = data.result.time;
                            player.current.canseek = data.result.can_seek;
                            player.current.remote_title = checkRemoteTitle(player.current);
                            // BBC iPlayer Extras streams can change duration. *But* on the duration in data.result seems to
                            // get updated. So, if there is a duration there, use that as the current tracks duration.
                            if (data.result.duration) {
                                player.current.duration = data.result.duration;
                            }
                        }

                        bus.$emit('playerStatus', player);

                        if (player.isplaying) {
                            var quickPoll = (LMS_STATUS_REFRESH_MAX/1000.0)*2;
                            if (player.current.time<quickPoll || (player.current.duration-player.current.time)<quickPoll) {
                                nextInterval = LMS_STATUS_REFRESH_MIN;
                            }
                        }
                    }
                    this.scheduleNextStatusUpdate(nextInterval);
                }).catch(err => {
                    if (!err.response) {
                        // If this is a network error, check if connection is up...
                        var that = this;
                        lmsCheckConnection().then(function (resp) {
                            that.scheduleNextStatusUpdate(500);
                        }).catch(err => {
                            bus.$emit('noNetwork');
                        });
                    } else {
                        logError(err);
                        this.scheduleNextStatusUpdate(LMS_STATUS_REFRESH_MIN);
                    }
                });
            } else {
                this.scheduleNextStatusUpdate(LMS_STATUS_REFRESH_MAX);
            }
        },
        removeFromQueue(indexes) {
            if (indexes.length>0) {
                var index = indexes.shift();
                lmsCommand(this.$store.state.player.id, ["playlist", "delete", index]).then(({data}) => {
                    if (indexes.length>0) {
                        this.removeFromQueue(indexes);
                    } else {
                        this.refreshStatus();
                    }
                });
            }
        },
        moveQueueItems(indexes, to, movedBefore, movedAfter) {
            if (indexes.length>0) {
                var index = indexes.shift();
                lmsCommand(this.$store.state.player.id, ["playlist", "move", index<to ? index-movedBefore : index,
                                                         index>to ? to+movedAfter+(movedBefore>0 ? 1 : 0) : to]).then(({data}) => {
                    if (indexes.length>0) {
                        this.moveQueueItems(indexes, to, index<to ? movedBefore+1 : movedBefore,
                                                         index>to ? movedAfter+1 : movedAfter);
                    } else {
                        this.refreshStatus();
                    }
                });
            }
        },
        doAllList(ids, command, section) {
            if (ids.length>0) {
                var id = ids.shift();
                var cmd = command.slice();
                cmd.push(id);
                lmsCommand(this.$store.state.player.id, cmd).then(({data}) => {
                    if (ids.length>0) {
                        this.doAllList(ids, command, section);
                    } else {
                        bus.$emit('refreshList', section);
                    }
                }).catch(err => {
                    bus.$emit('refreshList', section);
                });
            }
        }
    },
    created: function() {    
        this.refreshServerStatus();
        this.statusRefreshTimer = setTimeout(function () {
            this.refreshStatus();
        }.bind(this), LMS_STATUS_REFRESH_MAX);
    },
    mounted: function() {
        bus.$on('refreshStatus', function() {
	        this.refreshStatus();
        }.bind(this));
        bus.$on('playerCommand', function(command) {
            if (this.$store.state.player) {
                lmsCommand(this.$store.state.player.id, command).then(({data}) => {
                    this.refreshStatus();
                });
            }
        }.bind(this));
        bus.$on('removeFromQueue', function(indexes) {
            if (this.$store.state.player) {
                this.removeFromQueue(indexes);
            }
        }.bind(this));
        bus.$on('moveQueueItems', function(indexes, to) {
            if (this.$store.state.player) {
                this.moveQueueItems(indexes, to, 0, 0);
            }
        }.bind(this));
        bus.$on('doAllList', function(ids, command, section) {
            if (this.$store.state.player) {
                this.doAllList(ids, command, section);
            }
        }.bind(this));
        bus.$on('power', function(state) {
            lmsCommand(this.$store.state.player.id, ["power", state]).then(({data}) => {
                this.refreshServerStatus();
                this.refreshStatus();
            });
        }.bind(this));
        bus.$on('networkReconnected', function() {
            this.refreshServerStatus();
            this.refreshStatus();
        }.bind(this));
        bus.$on('updateServerStatus', function() {
            this.refreshServerStatus();
            this.refreshStatus();
        }.bind(this));
        bus.$on('adjustVolume', function(inc) {
            if (this.$store.state.player) {
                lmsCommand(this.$store.state.player.id, ["mixer", "volume", adjustVolume(this.volume, inc)]).then(({data}) => {
                    this.refreshStatus();
                });
            }
        }.bind(this));
    },
    watch: {
        '$store.state.player': function (newVal) {
            bus.$emit("playerChanged");
            this.refreshStatus();
        }
    },
    beforeDestroy() {
        if (undefined!==this.serverStatusRefreshInterval) {
            clearInterval(this.serverStatusRefreshInterval);
            this.serverStatusRefreshInterval = undefined;
        }
        if (undefined!==this.statusRefreshTimer) {
            clearTimeout(this.statusRefreshTimer);
            this.statusRefreshTimer = undefined;
        }
    }
});
