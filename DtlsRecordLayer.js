
"use strict";

var log = require( 'logg' ).getLogger( 'dtls.DtlsRecordLayer' );
var crypto = require( 'crypto' );

var DtlsPlaintext = require( './packets/DtlsPlaintext' );
var DtlsProtocolVersion = require( './packets/DtlsProtocolVersion' );
var DtlsChangeCipherSpec = require( './packets/DtlsChangeCipherSpec' );
var dtls = require( './dtls' );
var BufferReader = require( './BufferReader' );

var DtlsRecordLayer = function( dgram, rinfo, parameters ) {

    this.dgram = dgram;
    this.rinfo = rinfo;
    
    this.parameters = parameters;

    this.receiveEpoch = 0;
    this.sendEpoch = 0;
    this.version = new DtlsProtocolVersion({ major: ~1, minor: ~0 });
};

DtlsRecordLayer.prototype.getPackets = function( buffer, callback ) {

    var reader = new BufferReader( buffer );
    while( reader.available() ) {

        var packet = new DtlsPlaintext( reader );
        
        // Get the security parameters. Ignore the packet if we don't have
        // the parameters for the epoch.
        var parameters = this.parameters.getCurrent( packet.epoch );
        if( !parameters ) {
            log.error( 'Packet with unknown epoch:', packet.epoch );
            continue;
        }

        if( parameters.bulkCipherAlgorithm ) {
            this.decrypt( packet );
        }

        if( parameters.compressionAlgorithm ) {
            this.decompress( packet );
        }

        if( packet.type === dtls.MessageType.changeCipherSpec ) {
            if( packet.epoch !== this.receiveEpoch )
                continue;

            this.parameters.change();
            this.receiveEpoch = this.parameters.current;
        }

        callback( packet );
    }
};

DtlsRecordLayer.prototype.resendLast = function() {
    this.send( this.lastOutgoing );
};

DtlsRecordLayer.prototype.send = function( msg ) {

    var envelopes = [];
    if( !( msg instanceof Array ) )
        msg = [msg];

    for( var m in msg ) {
        var parameters = this.parameters.getCurrent( this.sendEpoch );
        var envelope = new DtlsPlaintext({
                type: msg[m].type,
                version: parameters.version,
                epoch: this.sendEpoch,
                sequenceNumber: parameters.sendSequence.next(),
                fragment: msg[m].getBuffer()
            });

        if( !parameters ) {
            log.error( 'Local epoch parameters not found:', this.sendEpoch );
            return;
        }

        if( parameters.bulkCipherAlgorithm ) {
            this.encrypt( envelope );
        }

        envelopes.push( envelope );
        if( msg[m].type === dtls.MessageType.changeCipherSpec )
            this.sendEpoch++;
    }

    this.lastOutgoing = envelopes;

    this.sendInternal( envelopes );
    return envelopes;
};

DtlsRecordLayer.prototype.sendInternal = function( envelopes ) {

    setTimeout( function() {
        for( var e in envelopes ) {
            var envelope = envelopes[e];

            var plaintextTypeName = dtls.MessageTypeName[ envelope.type ];

            var buffer = envelope.getBuffer();

            log.info( 'Sending', plaintextTypeName, '(', buffer.length, 'bytes)' );
            this.dgram.send( buffer,
                0, buffer.length,
                this.rinfo.port, this.rinfo.address );
        }
    }.bind( this ), 500 );
};

DtlsRecordLayer.prototype.decrypt = function( packet ) {
    var parameters = this.parameters.get( packet );

    var iv = packet.fragment.slice( 0, parameters.recordIvLength );
    var ciphered = packet.fragment.slice( parameters.recordIvLength );

    // Decrypt the fragment
    var cipher = parameters.getDecipher( iv );
    var decrypted = Buffer.concat([
        cipher.update( ciphered ),
        cipher.final() ]);

    packet.fragment = decrypted.slice( 0, decrypted.length - 21 );
    var mac = decrypted.slice( packet.fragment.length );

    // Verify MAC
    var header = this.getMacHeader( packet );
    var expectedMac = parameters.calculateIncomingMac([ header, packet.fragment ]);
    mac = mac.slice( 0, expectedMac.length );
    if( !mac.slice( 0, expectedMac.length ).equals( expectedMac ) ) {
        throw new Error( 'Mac mismatch: ' + expectedMac.toString( 'hex' ) + ' vs ' + mac.toString( 'hex' ) );
    }

    log.info( 'Message authenticated. MAC ok' );
};

DtlsRecordLayer.prototype.encrypt = function( packet ) {
    var parameters = this.parameters.get( packet );

    // Figure out MAC
    var iv = crypto.pseudoRandomBytes( 16 );
    var header = this.getMacHeader( packet );
    var mac = parameters.calculateOutgoingMac([ header, packet.fragment ]);

    var cipher = parameters.getCipher( iv );

    var blockSize = 16;
    var overflow = ( iv.length, packet.fragment.length + mac.length + 1 ) % blockSize;
    var padAmount = ( overflow === 0 ) ? 0 : ( blockSize - overflow );
    var padding = new Buffer([ padAmount ]);

    cipher.write( iv ); // The first chunk is used as IV and it's content is garbage.
    cipher.write( packet.fragment );
    cipher.write( mac );
    cipher.write( padding );
    cipher.end();

    packet.fragment = cipher.read();
};

DtlsRecordLayer.prototype.getMacHeader = function( packet ) {
    var header = new Buffer(13);
    header.writeUInt16BE( packet.epoch, 0 );
    packet.sequenceNumber.copy( header, 2 );
    header.writeUInt8( packet.type, 8 );
    header.writeInt8( packet.version.major, 9 );
    header.writeInt8( packet.version.minor, 10 );
    header.writeUInt16BE( packet.fragment.length, 11 );

    return header;
};

module.exports = DtlsRecordLayer;
