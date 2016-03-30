var EventEmitter = require('events').EventEmitter;
var Bottleneck = require('bottleneck');
var debug = require('debug')('sparky');
var util = require("util");
var req = require('request');
var _ = require('lodash');

function Sparky(config) {
  this.config = config;

  var self = this;
  
  // enable additional debug() events
  self.DEBUG = false;

  // validate token has been passed
  if(!self.config.token) throw new Error('missing token');

  // enable event emitter
  EventEmitter.call(self);

  // max search results
  self._maxItems = self.config.maxItems || 500;

  // max concurrent requests
  self._maxConcurrent = self.config.maxConcurrent || 2;

  // min time between requests
  self._minTime = self.config.minTime || 500;

  // time to wait between failed responses before retry
  self._requeueMinTime = self.config.requeueMinTime || self._minTime * 10;

  // max number of attempt to make for failed response
  self._requeueMaxRetry = self.config.requeueMaxRetry || 3;

  // response codes to requeue
  self._requeueCodes = self.config.requeueCodes || [ 429, 500, 503 ];

  // time to wait to recieve a response from api before failing
  self._requestTimeout = self.config.requestTimeout || 5000;

  // calculate queue sizes for limiters
  self._queueDepthTime = self.config.queueDepthTime || 20000;
  self._requeueDepthTime = self.config.requeueDepthTime || self._queueDepthTime * 2;
  self._queueSize = Math.floor(self._queueDepthTime / self._minTime); 
  self._requeueSize = Math.floor(self._requeueDepthTime / self._requeueMinTime); 

  // api url
  self._url = self.config.url || 'https://api.ciscospark.com/v1/';

  // webhook
  self._webhook = self.config.webhook || null;
  
  // token
  self.token = self.config.token;

  // queue for API calls
  self.queue = new Bottleneck(self._maxConcurrent, self._minTime, self._queueSize);
  
  // queue for API calls that fail
  self.requeue = new Bottleneck(self._maxConcurrent, self._requeueMinTime, self._requeueSize);

  // handle internal events
  self.on('request', function(url, requestOptions) {
    if(self.DEBUG) {
      debug('requested: %s', url || '<empty>');
    }
  });
  self.on('response', function(response) {
    if(self.DEBUG && response && response.headers && response.headers.trackingid) {
      debug('received response %s in %s(ms) with tracking id: %s', response.statusCode, response.elapsedTime, response.headers.trackingid); 
    } 
    else if( response && !response.ok && response.headers && response.headers.trackingid) {
      debug('received response %s in %s(ms) with tracking id: %s', response.statusCode, response.elapsedTime, response.headers.trackingid);
    }
  });
  self.on('retry', function(response) {
    if(self.DEBUG && response && response.headers) {
      debug('retry: %s', response.headers.trackingid); 
    }
  });
  self.on('error', function(err) {
    if(err) {
      debug('%s', err);
    }
  });

  // emit drop events from queue
  self.queue.on('dropped', function(request) {
    debug('queue size exceeded, dropping oldest request');
    self.emit('dropped', request);
  });

  // emit drop event from requeue
  self.requeue.on('dropped', function(request) {
    debug('requeue size exceeded, dropping oldest request');
    self.emit('dropped', request);
  });

  // load sparky api commands
  _.merge(self, self._run());
}
util.inherits(Sparky, EventEmitter);

// error handler
Sparky.prototype.errorHandler = function(message) {
  var self = this;

  // pargs arguments
  var args = Array.prototype.slice.call(arguments);

  // apply formatters to message and generate error
  var error = new Error(util.format.apply(this, args));
  
  // emit error
  self.emit('error', error);
  
  // return error object
  return error;
};

// perform api call
Sparky.prototype.call = function(method, resource, id, query, callback) {
  var self = this;

  var responseTimeout;

  // define headers
  var headers = {
    'Authorization': 'Bearer ' + self.token,
    'Content-Type': 'application/json'
  };

  // init error counter
  var errorCount = 0;

  // parse args
  var args = Array.prototype.slice.call(arguments);
  method = args.shift();
  resource = args.shift();
  // optional args
  id = (args.length > 0 && typeof args[0] === 'string') ? args.shift() : null;
  query = (args.length > 0 && typeof args[0] === 'object') ? args.shift() : null;
  callback = (args.length > 0 && typeof args[0] === 'function') ? args.shift() : null;

  // generate url
  id = id ? '/' + id : '';
  var url = self._url + resource + id;

  // define request options
  var requestOptions = {  
    url: url,
    headers: headers,
    method: method,
    timeout: self._requestTimeout,
    gzip: true,
    time: true
  };
  if(resource === 'contents') {
    requestOptions.encoding = 'binary';
  } else {
    requestOptions.json = true;
  }
  
  // define request content
  if(query) {
    if(method === 'post' || method === 'put') {
      requestOptions.body = query;
    } else {
      requestOptions.qs = query;
    }
  }

  // request complete
  function requestDone(err, response) {
    callback ? callback(err, response) : null;
    responseTimeout ? clearTimeout(responseTimeout) : null;
  }

  // request retry
  function requestRetry(response) {
    // increment error counter
    errorCount++;
    
    // if error count exceeded
    if(errorCount > self._requeueMaxRetry) {
      var err = self.errorHandler('failed after %s retries', self._requeueMaxRetry);
      
      requestDone(err, null);
    } else {
      // emit error for retry count
      self.errorHandler('retry #%s for request that generated %s response', errorCount, response.statusCode || 0);
      
      setTimeout(function() {

        // emit retry event
        self.emit('retry', response);

        // requeue request
        self.requeue.submit(request, null);

      }, self._requeueMinTime);
    }
  }

  // resuest callback
  function requestCallback(err, response, body) {

    if(err) {
      // emit error on processing request 
      err = self.errorHandler('processing spark api response');
      
      requestDone(err, null);
    } else {
      response.body = body || response.body;
      response.ok = (response.statusCode >= 200 && response.statusCode < 300);

      // emit response event
      self.emit('response', response);

      // catch specific error response codes to requeue
      if(_.includes(self._requeueCodes, response.statusCode)) {
        // retry 
        requestRetry(response);
      }
      
      // if 204 received from successfull delete
      else if(response.statusCode === 204) {
        requestDone(null, null);
      }

      // catch file response from contents api
      else if(response.ok && response.headers && response.body
        && !response.headers['content-type'].includes('application/json')
        && resource === 'contents') 
      {
        requestDone(null, response);
      }
      
      // if normal response
      else if(response.ok && response.body) {
        // if items array found
        if(response.body.items && response.body.items.length > 0) {
          requestDone(null, response.body.items);
        }
        
        // if items array not found and single object located in body
        else if(!response.body.items && response.body.id) {
          // return as array
          requestDone(null, [ response.body ]);
        }
        
        // no item(s) returned
        else {
          requestDone(null, []);
        }
      } else {
        // emit error for processing response
        err = self.errorHandler('processing spark api response');

        requestDone(err, null);
      }
    } 
  }

  // send request
  function request(end){
    req(requestOptions, requestCallback).on('end', function() {
      end();
    });
  }

  // submit initial request to queue
  self.queue.submit(request, null);

  // emit request event
  self.emit('request', requestOptions);

  // send callback as failed if response is not recieved after a time
  responseTimeout = setTimeout(function() {
    var err = self.errorHandler('request timed out in queue');
    requestDone(err, null);
  }, (self._queueDepthTime + self._requeueDepthTime) * 2);

};

// api commands
Sparky.prototype._run = function() {
  var self = this;

  return {
    rooms: {
      get: function(cb) {
        self.call('get', 'rooms', { max: self._maxItems }, cb);
      }
    },
    room: {
      get: function(id, cb) {
        self.call('get', 'rooms', id, { showSipAddress: true }, cb);
      },
      add: function(title, cb) {
        self.call('post', 'rooms', { title: title }, cb);
      },
      rename: function(id, title, cb) {
        self.call('put', 'rooms', id, { title: title }, cb);
      },
      remove: function(id, cb) {
        self.call('delete', 'rooms', id, cb);
      }
    },
    people: {
      search: function(displayName, cb) {
        self.call('get', 'people', {
          displayName: displayName,
          max: self._maxItems
        }, cb);
      }
    },
    person: {
      get: function(id, cb) {
        self.call('get', 'people', id, cb);
      },
      me: function(cb) {
        self.call('get', 'people', 'me', cb);
      },
      byEmail: function(email, cb) {
        self.call('get', 'people', { email: email }, cb);
      }
    },
    messages: {
      get: function(roomId, max, cb) {
        // parse args
        var args = Array.prototype.slice.call(arguments);
        roomId = args.shift();
        cb = args.pop();
        // optional args
        max = (args.length > 0 && typeof args[0] === 'number') ? args.shift() : null;

        self.call('get', 'messages', {
          roomId: roomId,
          max: max || self._maxItems
        }, cb);
      }
    },
    message: {
      get: function(id, cb) {
        self.call('get', 'messages', id, cb);
      },
      send: {
        person: function(email, message, cb) {
          message.toPersonEmail = email;
          self.call('post', 'messages', message, cb);
        },
        room: function(roomId, message, cb) {
          message.roomId = roomId;
          self.call('post', 'messages', message, cb);
        }
      },
      remove: function(id, cb) {
        self.call('delete', 'messages', id, cb);
      }
    },
    contents: {
      get: function(id, cb) {
        self.call('get', 'contents', id, function(err, res) {
          if(err) {
            cb(err, null);
          } else {
            // get file
            var contents = {};
            contents.name = res.headers['content-disposition'].match(/"(.*)"/)[1];
            contents.type = res.headers['content-type'];
            contents.binary = new Buffer(res.body, 'binary');
            contents.base64 = new Buffer(res.body, 'binary').toString('base64');

            cb(null, contents);
          }
        });
      },
      byUrl: function(url, cb) {
        var id = url.match(/contents\/(.*)/)[1];
        self.contents.get(id, cb);
      }
    },
    memberships: {
      get: function(cb) {
        self.call('get', 'memberships', { max: self._maxItems }, cb);
      },
      byRoom: function(roomId, cb) {
        self.call('get', 'memberships', {
          roomId: roomId,
          max: self._maxItems
        }, cb);
      }
    },
    membership: {
      get: function(id, cb) {
        self.call('get', 'memberships', id, cb);
      },
      byRoomByEmail: function(roomId, personEmail, cb) {
        self.call('get', 'memberships', {
          roomId: roomId,
          personEmail: personEmail
        }, cb);
      },
      add: function(roomId, email, cb) {
        self.call('post', 'memberships', {
          personEmail: email,
          roomId: roomId,
          isModerator: false
        }, cb);
      },
      set: {
        moderator: function(id, cb) {
            self.call('put', 'memberships', id, { isModerator: false }, cb);
        }
      },
      clear: {
        moderator: function(id, cb) {
            self.call('put', 'memberships', id, { isModerator: false }, cb);
        }
      },
      remove: function(id, cb) {
        self.call('delete', 'memberships', id, cb);
      }
    },
    webhooks: {
      get: function(cb) {
        self.call('get', 'webhooks', { max: self._maxItems }, cb);
      }
    },
    webhook: {
      get: function(id, cb) {
        self.call('get', 'webhooks', id, cb);
      },
      add: {
        messages: {
          created: {
            room: function(roomId, name, cb) {
              // parse args
              var args = Array.prototype.slice.call(arguments);
              roomId = args.shift();
              cb = args.pop();
              // optional args
              name = (args.length > 0 && typeof args[0] === 'string') ? args.shift() : null;

              // check if webhook url is defined in options
              if(!self._webhook) throw new Error('webhook url not specified');
              self.call('post', 'webhooks', {
                resource: 'messages',
                event: 'created',
                filter: 'roomId=' + roomId,
                targetUrl: self._webhook,
                name: name || roomId
              }, cb);
            }
          }
        }
      },
      remove: function(id, cb) {
        self.call('delete', 'webhooks', id, cb);
      }
    }
  };

};

module.exports = Sparky;