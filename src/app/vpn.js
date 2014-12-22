(function (App) {
	'use strict';

	var request = require('request'),
		Q = require('q'),
		tar = require('tar'),
		temp = require('temp'),
		zlib = require('zlib'),
		mv = require('mv'),
		fs = require('fs'),
		path = require('path'),
		password;

	temp.track();

	function VPN() {
		if (!(this instanceof VPN)) {
			return new VPN();
		}
		this.running = false;
		this.ip = false;
	}

	VPN.prototype.isInstalled = function () {
		// just to make sure we have a config value
		if (haveBinaries()) {
			// we'll fallback to check if it's been installed
			// form the app ?
			var installed = AdvSettings.get('vpn');
			if (installed) {
				return true;
			} else {
				return false;
			}
		}

		return false;
	};

	VPN.prototype.isDisabled = function () {
		//disabled on demand
		var disabled = AdvSettings.get('vpnDisabledPerm');
		if (disabled) {
			return true;
		} else {
			return false;
		}
	};

	VPN.prototype.isRunning = function (checkOnStart) {
		var defer = Q.defer();
		var self = this;

		checkOnStart = checkOnStart || false;

		if (this.isInstalled()) {

			if (process.platform === 'win32') {

				var root;
				if (process.env.SystemDrive) {
					root = process.env.SystemDrive;
				} else {
					root = process.env.SystemRoot.split(path.sep)[0];
					// fallback if we dont get it
					if (root.length === 0) {
						root = 'C:';
					}
				}

				root = path.join(root, 'Windows', 'System32', 'sc.exe');

				var exec = require('child_process').exec;
				var child = exec(root + ' query OpenVPNService | findstr /i "STATE"',
					function (error, stdout, stderr) {
						if (error !== null) {
							console.log('exec error: ' + error);
							return 1;
						} else {

							if (stdout.trim().indexOf('RUNNING') > 1) {
								self.running = true;
								defer.resolve(true);

								// if its the call from the startup
								// we'll trigger a reload on our UI
								// to show the connexion state

								if (checkOnStart) {
									App.vent.trigger('movies:list');
								}

							} else {
								self.running = false;
								defer.resolve(false);
							}

						}

					});

			} else {

				getPid()
					.then(function (pid) {

						self.getIp();

						if (pid) {
							self.running = true;
							defer.resolve(true);

							// if its the call from the startup
							// we'll trigger a reload on our UI
							// to show the connexion state

							if (checkOnStart) {
								App.vent.trigger('movies:list');
							}

						} else {
							self.running = false;
							defer.resolve(false);
						}
					});

			}
		}

		return defer.promise;
	};

	VPN.prototype.getIp = function (callback) {
		var defer = Q.defer();
		var self = this;

		request('http://curlmyip.com/', function (error, response, body) {
			if (!error && response.statusCode === 200) {
				self.ip = body.trim();
				defer.resolve(self.ip);
			} else {
				defer.reject(error);
			}
		});

		return defer.promise;
	};

	VPN.prototype.install = function () {
		var self = this;

		if (process.platform === 'darwin') {

			return this.installRunAs()
				.then(self.installMac)
				.then(self.downloadConfig)
				.then(function () {
					// we told pt we have vpn enabled..
					AdvSettings.set('vpn', true);
				});

		} else if (process.platform === 'linux') {

			return this.installLinux()
				.then(self.downloadConfig)
				.then(function () {
					// ok we are almost done !

					// we told pt we have vpn enabled..
					AdvSettings.set('vpn', true);
				});

		} else if (process.platform === 'win32') {

			return this.installRunAs()
				.then(self.downloadConfig)
				.then(self.installWin)
				.then(function () {
					// ok we are almost done !

					// we told pt we have vpn enabled..
					AdvSettings.set('vpn', true);
				});
		}

		//

	};

	VPN.prototype.installRunAs = function () {

		// make sure path doesn't exist (for update)
		try {
			if (fs.existsSync(path.resolve(process.cwd(), 'node_modules', 'runas'))) {
				fs.rmdirSync(path.resolve(process.cwd(), 'node_modules', 'runas'));
			}
		} catch (e) {
			console.log(e);
		}

		// we get our arch & platform
		var arch = process.arch === 'ia32' ? 'x86' : process.arch;
		var platform = process.platform === 'darwin' ? 'mac' : process.platform;
		var self = this;

		// force x86 as we only have nw 32bit
		// for mac & windows
		if (platform === 'mac' || platform === 'win32') {
			arch = 'x86';
		}


		var tarball = 'https://s3-eu-west-1.amazonaws.com/vpnht/runas-' + platform + '-' + arch + '.tar.gz';

		return downloadTarballAndExtract(tarball)
			.then(function (temp) {
				// we install the runas module
				console.log('runas imported');
				return copyToLocation(
					path.resolve(process.cwd(), 'node_modules', 'runas'),
					temp
				);
			});
	};

	VPN.prototype.downloadConfig = function () {
		// make sure path exist
		try {
			if (!fs.existsSync(getInstallPath())) {
				fs.mkdirSync(getInstallPath());
			}
		} catch (e) {
			console.log(e);
		}

		var configFile = 'https://s3-eu-west-1.amazonaws.com/vpnht/openvpn.conf';
		return downloadFileToLocation(configFile, 'config.ovpn')
			.then(function (temp) {
				return copyToLocation(
					path.resolve(getInstallPath(), 'openvpn.conf'),
					temp
				);
			});
	};

	VPN.prototype.installMac = function () {

		var tarball = 'https://s3-eu-west-1.amazonaws.com/vpnht/openvpn-mac.tar.gz';

		return downloadTarballAndExtract(tarball)
			.then(function (temp) {
				// we install openvpn
				return copyToLocation(
					getInstallPath(),
					temp
				);
			});

	};

	VPN.prototype.installWin = function () {

		var arch = process.arch === 'ia32' ? 'x86' : process.arch;
		var installFile = 'https://s3-eu-west-1.amazonaws.com/vpnht/openvpn-windows-' + arch + '.exe';
		return downloadFileToLocation(installFile, 'setup.exe')
			.then(function (temp) {

				// we launch the setup with admin privilege silently
				// and we install openvpn in %USERPROFILE%\.openvpn
				try {
					return runas(temp, ['/S', 'SELECT_SERVICE=1', '/SELECT_SHORTCUTS=0', '/SELECT_OPENVPNGUI=0', '/D=' + getInstallPath()]);
				} catch (e) {
					console.log(e);
					return false;
				}

			});
	};

	VPN.prototype.installLinux = function () {
		// we get our arch & platform
		var arch = process.arch === 'ia32' ? 'x86' : process.arch;
		var tarball = 'https://s3-eu-west-1.amazonaws.com/vpnht/openvpn-linux-' + arch + '.tar.gz';

		return downloadTarballAndExtract(tarball)
			.then(function (temp) {
				// we install openvpn
				return copyToLocation(
					getInstallPath(),
					temp
				);
			});
	};

	VPN.prototype.disconnect = function () {
		var defer = Q.defer();
		var self = this;

		// need to run first..
		if (!this.running) {
			defer.resolve();
		}

		if (process.platform === 'win32') {

			var root;
			if (process.env.SystemDrive) {
				root = process.env.SystemDrive;
			} else {
				root = process.env.SystemRoot.split(path.sep)[0];
				// fallback if we dont get it
				if (root.length === 0) {
					root = 'C:';
				}
			}

			root = path.join(root, 'Windows', 'System32', 'net.exe');

			// we need to stop the service
			runas(root, ['stop', 'OpenVPNService']);
			self.getIp();
			self.running = false;
			console.log('openvpn stoped');
			defer.resolve();

		} else {
			getPid()
				.then(function (pid) {

					if (pid) {

						runas('kill', ['-9', pid], {
							admin: true
						});

						// we'll delete our pid file
						try {
							fs.unlinkSync(path.join(getInstallPath(), 'vpnht.pid'));
						} catch (e) {
							console.log(e);
						}

						self.getIp();
						self.running = false;
						console.log('openvpn stoped');

						defer.resolve();

					} else {
						console.log('no pid found');
						self.running = false;
						defer.reject('no_pid_found');
					}
				});
		}

		return defer.promise;
	};

	VPN.prototype.connect = function () {
		var defer = Q.defer();
		var self = this;
		// we are writing a temp auth file
		fs = require('fs');
		var tempPath = temp.mkdirSync('popcorntime-vpnht');
		tempPath = path.join(tempPath, 'o1');
		fs.writeFile(tempPath, Settings.vpnUsername + '\n' + Settings.vpnPassword, function (err) {
			if (err) {

				defer.reject(err);

			} else {

				// ok we have our auth file
				// now we need to make sure we have our openvpn.conf
				var vpnConfig = path.resolve(getInstallPath(), 'openvpn.conf');
				if (fs.existsSync(vpnConfig)) {

					try {

						var openvpn = path.resolve(getInstallPath(), 'openvpn');
						var args = ['--daemon', '--writepid', path.join(getInstallPath(), 'vpnht.pid'), '--log-append', path.join(getInstallPath(), 'vpnht.log'), '--config', vpnConfig, '--auth-user-pass', tempPath];

						if (process.platform === 'linux') {
							// in linux we need to add the --dev tun0
							args = ['--daemon', '--writepid', path.join(getInstallPath(), 'vpnht.pid'), '--log-append', path.join(getInstallPath(), 'vpnht.log'), '--dev', 'tun0', '--config', vpnConfig, '--auth-user-pass', tempPath];
						}

						// execption for windows openvpn path
						if (process.platform === 'win32') {

							// we copy our openvpn.conf for the windows service
							var newConfig = path.resolve(getInstallPath(), 'config', 'openvpn.ovpn');

							copy(vpnConfig, newConfig, function (err) {

								if (err) {
									console.log(err);
								}

								fs.appendFile(newConfig, '\r\nauth-user-pass ' + tempPath.replace(/\\/g, '\\\\'), function (err) {

									var root;
									if (process.env.SystemDrive) {
										root = process.env.SystemDrive;
									} else {
										root = process.env.SystemRoot.split(path.sep)[0];
										// fallback if we dont get it
										if (root.length === 0) {
											root = 'C:';
										}
									}

									root = path.join(root, 'Windows', 'System32', 'net.exe');

									if (fs.existsSync(root)) {

										runas(root, ['start', 'OpenVPNService']);
										self.running = true;
										console.log('openvpn launched');
										// set our current ip
										self.getIp();
										defer.resolve();

									} else {
										defer.reject('openvpn_command_not_found');
									}
								});

							});

						} else {

							if (fs.existsSync(openvpn)) {

								// we'll delete our pid file to
								// prevent any connexion error

								try {
									if (fs.existsSync(path.join(getInstallPath(), 'vpnht.pid'))) {
										fs.unlinkSync(path.join(getInstallPath(), 'vpnht.pid'));
									}
								} catch (e) {
									console.log(e);
								}


								if (runas(openvpn, args, {
										admin: true
									}) !== 0) {

									// we didnt got success but process run anyways..
									console.log('something wrong');
									self.running = true;
									self.getIp();
									defer.resolve();

								} else {

									self.running = true;
									console.log('openvpn launched');
									// set our current ip
									self.getIp();
									defer.resolve();

								}
							}
						}

					} catch (e) {
						defer.reject('error_runas');
					}

				} else {
					defer.reject('openvpn_config_not_found');
				}
			}

		});

		return defer.promise;
	};

	var downloadTarballAndExtract = function (url) {
		var defer = Q.defer();
		var tempPath = temp.mkdirSync('popcorntime-openvpn-');
		var stream = tar.Extract({
			path: tempPath
		});

		stream.on('end', function () {
			defer.resolve(tempPath);
		});
		stream.on('error', function () {
			defer.resolve(false);
		});
		createReadStream({
			url: url
		}, function (requestStream) {
			requestStream.pipe(zlib.createGunzip()).pipe(stream);
		});

		return defer.promise;
	};

	var downloadFileToLocation = function (url, name) {
		var defer = Q.defer();
		var tempPath = temp.mkdirSync('popcorntime-openvpn-');
		tempPath = path.join(tempPath, name);
		var stream = fs.createWriteStream(tempPath);
		stream.on('finish', function () {
			defer.resolve(tempPath);
		});
		stream.on('error', function () {
			defer.resolve(false);
		});
		createReadStream({
			url: url
		}, function (requestStream) {
			requestStream.pipe(stream);
		});
		return defer.promise;
	};

	var createReadStream = function (requestOptions, callback) {
		return callback(request.get(requestOptions));
	};

	// move file
	var copyToLocation = function (targetFilename, fromDirectory) {
		var defer = Q.defer();

		mv(fromDirectory, targetFilename, function (err) {
			defer.resolve(err);
		});

		return defer.promise;

	};

	// copy instead of mv (so we keep original)
	var copy = function (source, target, cb) {

		var cbCalled = false;

		var rd = fs.createReadStream(source);
		rd.on('error', function (err) {
			done(err);
		});

		var wr = fs.createWriteStream(target);
		wr.on('error', function (err) {
			done(err);
		});
		wr.on('close', function (ex) {
			done();
		});
		rd.pipe(wr);

		function done(err) {
			if (!cbCalled) {
				cb(err);
				cbCalled = true;
			}
		}
	};

	var getPid = function () {
		var defer = Q.defer();
		fs.readFile(path.join(getInstallPath(), 'vpnht.pid'), 'utf8', function (err, data) {

			if (err) {
				defer.resolve(false);
			} else {
				defer.resolve(data.trim());
			}

		});

		return defer.promise;
	};

	var getInstallPath = function () {

		switch(process.platform) {
			case 'darwin':
			case 'linux':
				return path.join(process.env.HOME, '.openvpn');
			break;
			case 'win32':
				return path.join(process.env.USERPROFILE, '.openvpn');
			break;

			default:
				return false;
			break;
		}

	};

	var haveBinaries = function () {

		switch(process.platform) {
			case 'darwin':
			case 'linux':
				return fs.existsSync(path.resolve(getInstallPath(), 'openvpn'));
			break;
			case 'win32':
				return fs.existsSync(path.resolve(getInstallPath(), 'bin', 'openvpn.exe'));
			break;

			default:
				return false;
			break;
		}

	};

	var runas = function (cmd, args, options) {
		var runasApp;
		if (process.platform === 'linux') {
			if (!password) {
				password = prompt('ATTENTION! We need admin acccess to run this command.\n\nYour password is not saved\n\nEnter sudo password : ', '');
			}

			var exec = require('child_process').exec;
			var child = exec('sudo ' + cmd + ' ' + args.join(' '),
				function (error, stdout, stderr) {
					if (error !== null) {
						console.log('exec error: ' + error);
						return 1;
					}
				});

			child.stdin.write(password);
			return 0;

		} else if (process.platform === 'win32') {

			try {

				runasApp = require('runas');
				runasApp(cmd + ' ' + args.join(' '), function (error) {
					if (error !== null) {
						return 1;
					}
				});
				return 0;

			} catch (e) {
				console.log(e);
				return 1;
			}

		} else {

			try {
				runasApp = require('runas');
				return runasApp(cmd, args, options);
			} catch (e) {
				console.log(e);
				return 1;
			}

		}

	};

	// initialize VPN instance globally
	App.VPN = new VPN();

})(window.App);
